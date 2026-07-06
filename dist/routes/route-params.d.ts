import type { Request } from "express";
export declare function routeParam(req: Pick<Request, "params">, name: string): string;
