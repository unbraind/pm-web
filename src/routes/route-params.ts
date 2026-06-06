import type { Request } from "express";

export function routeParam(req: Pick<Request, "params">, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}
