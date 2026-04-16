import api from "./api";
import type { AxiosError } from "axios";

export interface ProductoFilters {
  localId?: string | number | null;
  stockMin?: number | string;
  stockMax?: number | string;
  precioMin?: number | string;
  precioMax?: number | string;
}

const applyProductoFilters = (
  params: { [key: string]: string | number | undefined },
  filters?: ProductoFilters
) => {
  if (!filters) return;
  if (filters.localId != null && filters.localId !== "")
    params.localId = filters.localId;
  if (filters.stockMin != null && filters.stockMin !== "")
    params.stockMin = filters.stockMin;
  if (filters.stockMax != null && filters.stockMax !== "")
    params.stockMax = filters.stockMax;
  if (filters.precioMin != null && filters.precioMin !== "")
    params.precioMin = filters.precioMin;
  if (filters.precioMax != null && filters.precioMax !== "")
    params.precioMax = filters.precioMax;
};

// Traer todos los productos sin paginación
export const getProductos = async (params = {}) => {
  const res = await api.get("/productos/all", { params });
  return res.data;
};

// Traer productos paginados
export const getProductosPaginated = async (
  page = 1,
  limit = 10,
  sortBy?: string,
  sortOrder?: "asc" | "desc",
  filters?: ProductoFilters
) => {
  const params: { [key: string]: string | number | undefined } = {
    page,
    limit,
  };
  if (sortBy) params.sortBy = sortBy;
  if (sortOrder) params.sortOrder = sortOrder;
  applyProductoFilters(params, filters);
  try {
    const response = await api.get("/productos", { params });
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw (
      axiosError.response?.data || { message: "Error al obtener productos" }
    );
  }
};

export const getProductosAll = async () => {
  const res = await api.get("/productos/all");
  return res.data;
};

export const getProductoById = async (id: string | number) => {
  try {
    const response = await api.get(`/productos/${id}`);
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw axiosError.response?.data || { message: "Error al obtener producto" };
  }
};

export const createProducto = async (productoData: Record<string, unknown>) => {
  try {
    const response = await api.post("/productos", productoData);
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw axiosError.response?.data || { message: "Error al crear producto" };
  }
};

export const updateProducto = async (
  id: string | number,
  productoData: Record<string, unknown>
) => {
  try {
    const response = await api.put(`/productos/${id}`, productoData);
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw (
      axiosError.response?.data || { message: "Error al actualizar producto" }
    );
  }
};

export const deleteProducto = async (id: string | number) => {
  try {
    const response = await api.delete(`/productos/${id}`);
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw (
      axiosError.response?.data || { message: "Error al eliminar producto" }
    );
  }
};

export const searchProductos = async (
  searchTerm: string,
  page = 1,
  limit = 10,
  sortBy?: string,
  sortOrder?: "asc" | "desc",
  filters?: ProductoFilters
) => {
  const params: { [key: string]: string | number | undefined } = {
    q: searchTerm,
    page,
    limit,
  };
  if (sortBy) params.sortBy = sortBy;
  if (sortOrder) params.sortOrder = sortOrder;
  applyProductoFilters(params, filters);
  try {
    const response = await api.get("/productos/search", { params });
    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw axiosError.response?.data || { message: "Error al buscar productos" };
  }
};

export interface ProductoMovimientoRow {
  ProductoId: number;
  ProductoCodigo: string;
  ProductoNombre: string;
  /** Cajas vendidas en el período (suma de VentaProductoCantidad). */
  CantidadVendidaCajas: number;
  /** Unidades sueltas vendidas en el período (suma de VentaProductoUnitario). */
  CantidadVendidaUnidades: number;
  MontoVendido: number;
  CostoVendido: number;
  /** Cajas compradas (filas de compraproducto con CompraProductoCantidadUnidad='C'). */
  CantidadCompradaCajas: number;
  /** Unidades compradas (filas con CompraProductoCantidadUnidad='U'). */
  CantidadCompradaUnidades: number;
  MontoComprado: number;
}

export interface ReporteMovimientosResponse {
  productos: ProductoMovimientoRow[];
  fechaDesde: string;
  fechaHasta: string;
}

/**
 * Reporte de productos vendidos y comprados en un rango de fechas.
 * Devuelve solo productos con movimiento. La ganancia y el margen se calculan
 * en el frontend a partir de MontoVendido - CostoVendido.
 */
export const getReporteMovimientosProductos = async (
  fechaDesde: string,
  fechaHasta: string
): Promise<ReporteMovimientosResponse> => {
  try {
    const response = await api.get("/productos/reporte-movimientos", {
      params: { fechaDesde, fechaHasta },
    });
    return response.data?.data as ReporteMovimientosResponse;
  } catch (error) {
    const axiosError = error as AxiosError<{ message?: string }>;
    throw (
      axiosError.response?.data || {
        message: "Error al generar el reporte de movimientos",
      }
    );
  }
};
