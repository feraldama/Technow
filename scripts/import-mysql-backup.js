// Importa el dump phpMyAdmin de client/public/mysql.sql a la BD PostgreSQL.
// Trunca las tablas presentes en el dump y reinserta sus filas.
// - Quita los backticks de los identificadores (PG los baja a lowercase, que es
//   como están físicamente en el schema, según api/config/db.js).
// - Convierte los literales hex MySQL `0xABCD` a `'\xABCD'::bytea` para las
//   columnas BLOB (producto.ProductoImagen).
// - Desactiva los chequeos de FK durante la transacción con
//   session_replication_role = replica.
// - Resetea las secuencias SERIAL a MAX(pk)+1 después de insertar.
//
// Uso: node scripts/import-mysql-backup.js
const fs = require("fs");
const path = require("path");

const API_DIR = path.join(__dirname, "..", "api");
require(path.join(API_DIR, "node_modules", "dotenv")).config({
  path: path.join(API_DIR, ".env"),
});
const { Pool } = require(path.join(API_DIR, "node_modules", "pg"));

const SQL_FILE = path.join(__dirname, "..", "client", "public", "mysql.sql");

// Las secuencias se descubren en runtime consultando pg_get_serial_sequence
// para cada columna de cada tabla del dump, así no hace falta mantener un map.

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "technow",
  port: parseInt(process.env.DB_PORT, 10) || 5432,
});

// Lee un string literal MySQL desde sql[i] (que es la comilla de apertura).
// Devuelve [strContent, endIndex] donde endIndex es el índice DESPUÉS de la
// comilla de cierre. strContent es el string completo (incluyendo comillas)
// listo para ser emitido como PG E'...' literal — los backslash-escapes
// MySQL (\', \\, \n, etc.) se interpretan igual en PG E'...'.
function readMysqlString(sql, i) {
  let out = "'";
  i++;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "\\" && i + 1 < n) {
      // Backslash-escape MySQL: copiar tal cual; PG E'...' lo interpreta igual.
      out += "\\" + sql[i + 1];
      i += 2;
    } else if (c === "'" && sql[i + 1] === "'") {
      out += "''";
      i += 2;
    } else if (c === "'") {
      out += "'";
      i++;
      return [out, i];
    } else {
      out += c;
      i++;
    }
  }
  return [out, i];
}

function splitStatements(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'") {
      const [str, next] = readMysqlString(sql, i);
      cur += str;
      i = next;
    } else if (ch === ";") {
      const t = cur.trim();
      if (t) out.push(t);
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

// Reescribe el statement para PG:
//  - Strings se emiten con prefijo E'...' (los backslash-escapes MySQL se
//    interpretan idénticamente en PG E'...' string literals).
//  - Fuera de strings, los backticks se eliminan (identificadores van unquoted
//    y PG los baja a lowercase, que es como están físicamente en el schema).
//  - Fuera de strings, `0xHEX` se convierte a E'\\xHEX'::bytea para los BLOBs.
function rewriteOutsideStrings(stmt) {
  let out = "";
  let buf = "";
  let i = 0;
  const n = stmt.length;
  const flushBuf = () => {
    out += buf
      .replace(/`/g, "")
      .replace(/\b0x([0-9a-fA-F]+)\b/g, (_, hex) => `E'\\\\x${hex}'::bytea`);
    buf = "";
  };
  while (i < n) {
    const ch = stmt[i];
    if (ch === "'") {
      flushBuf();
      const [str, next] = readMysqlString(stmt, i);
      out += "E" + str;
      i = next;
    } else {
      buf += ch;
      i++;
    }
  }
  flushBuf();
  return out;
}

// El dump trae comentarios `-- Volcado ...` justo antes de cada INSERT y mi
// splitStatements no los descarta (se quedan pegados al statement). Estos
// helpers buscan el INSERT saltando los comentarios de línea iniciales.
function isInsert(stmt) {
  return /(?:^|\n)\s*INSERT\s+INTO\b/i.test(stmt);
}

function detectInsertTable(stmt) {
  const m = stmt.match(/(?:^|\n)\s*INSERT\s+INTO\s+`?(\w+)`?/i);
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  console.log(`Leyendo ${SQL_FILE}`);
  const sql = fs.readFileSync(SQL_FILE, "utf8");
  console.log(`  ${sql.length} bytes`);

  console.log("Parseando statements...");
  const statements = splitStatements(sql);
  const inserts = statements.filter(isInsert);
  const tablesOrdered = [];
  const seen = new Set();
  for (const s of inserts) {
    const t = detectInsertTable(s);
    if (t && !seen.has(t)) {
      seen.add(t);
      tablesOrdered.push(t);
    }
  }
  console.log(
    `  ${inserts.length} INSERTs, ${tablesOrdered.length} tablas: ${tablesOrdered.join(", ")}`
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET session_replication_role = replica");
    console.log("Transacción iniciada (FK checks OFF)");

    // DELETE en vez de TRUNCATE: hay FKs entrantes desde tablas que no están
    // en el dump (factura, asistencia, etc.) y TRUNCATE las chequea aunque
    // session_replication_role esté en replica. DELETE sí respeta la flag.
    for (const t of tablesOrdered) {
      const r = await client.query(`DELETE FROM ${t}`);
      console.log(`  DELETE FROM ${t} (${r.rowCount} filas)`);
    }

    console.log(`Ejecutando ${inserts.length} INSERTs...`);
    const perTableCount = {};
    let done = 0;
    for (const stmt of inserts) {
      const t = detectInsertTable(stmt);
      const rewritten = rewriteOutsideStrings(stmt);
      try {
        const r = await client.query(rewritten);
        perTableCount[t] = (perTableCount[t] || 0) + (r.rowCount || 0);
      } catch (err) {
        console.error(`\nFalló INSERT #${done + 1} en tabla ${t}`);
        console.error(`  ${err.message}`);
        console.error(`  SQL (primeros 300 chars): ${rewritten.slice(0, 300)}`);
        throw err;
      }
      done++;
      if (done % 50 === 0 || done === inserts.length) {
        process.stdout.write(`  ${done}/${inserts.length}\r`);
      }
    }
    console.log("");

    // El dump MySQL trae varias columnas CHAR(N) con padding de espacios
    // baked en el literal ('faldama     '). PG las guarda en varchar pero el
    // padding rompe los lookups por PK/FK. RTRIM a las que detectamos.
    const RTRIM_COLS = [
      ["usuario", "usuarioid"],
      ["usuarioperfil", "usuarioid"],
      ["registrodiariocaja", "usuarioid"],
      ["local", "localdireccion"],
    ];
    console.log("Limpiando trailing whitespace (efecto CHAR(N) en MySQL)...");
    for (const [t, c] of RTRIM_COLS) {
      if (!seen.has(t)) continue;
      const r = await client.query(
        `UPDATE ${t} SET ${c} = rtrim(${c}) WHERE ${c} <> rtrim(${c})`
      );
      if (r.rowCount) console.log(`  ${t}.${c}: ${r.rowCount} filas`);
    }

    console.log("Reseteando secuencias...");
    for (const t of tablesOrdered) {
      const cols = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [t]
      );
      for (const { column_name: col } of cols.rows) {
        const seqRes = await client.query(
          "SELECT pg_get_serial_sequence($1, $2) AS seq",
          [t, col]
        );
        const seq = seqRes.rows[0] && seqRes.rows[0].seq;
        if (!seq) continue;
        await client.query(
          `SELECT setval('${seq}', COALESCE((SELECT MAX(${col}) FROM ${t}), 0) + 1, false)`
        );
        console.log(`  ${seq} -> MAX(${t}.${col})+1`);
      }
    }

    await client.query("SET session_replication_role = DEFAULT");
    await client.query("COMMIT");
    console.log("COMMIT OK");

    console.log("\nVerificación de conteos:");
    for (const t of tablesOrdered) {
      const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      const inserted = perTableCount[t] || 0;
      const total = r.rows[0].c;
      const flag = inserted === total ? "OK" : "MISMATCH";
      console.log(`  ${t}: insertados=${inserted}, total=${total} ${flag}`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nIMPORT FALLÓ, rollback aplicado");
    console.error(err.message);
    if (err.position) console.error(`position=${err.position}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
