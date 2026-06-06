export function routeParam(req, name) {
    const value = req.params[name];
    if (Array.isArray(value))
        return value[0] ?? "";
    return value ?? "";
}
//# sourceMappingURL=route-params.js.map