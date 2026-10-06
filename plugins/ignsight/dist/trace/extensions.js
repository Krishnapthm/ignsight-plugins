import { REDACTED, redactString, TRUNCATED_SUFFIX } from "./redact.js";
/** Bound and redact adapter-attributed names. Only actual usage belongs in evidence. */
export function extensionEvents(usages) {
    return usages.slice(0, 128).flatMap((usage) => {
        if (usage.plugin === "ignsight" && ["connect", "status"].includes(usage.name))
            return [];
        const payload = { ...usage };
        const markers = [];
        const name = (value, pointer) => {
            const clean = redactString(value);
            const count = clean.split(REDACTED).length - value.split(REDACTED).length;
            if (count > 0)
                markers.push({ kind: "secret_redacted", pointer, count });
            if (clean.length > 255) {
                markers.push({ kind: "truncated", pointer });
                return clean.slice(0, 255 - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX;
            }
            return clean || "unattributed";
        };
        for (const key of ["name", "server", "connector", "plugin", "tool_call_id"]) {
            const value = payload[key];
            if (value !== undefined)
                payload[key] = name(value, `/${key}`);
        }
        // Raw native names are bounded too; no arguments, URLs, commands or content.
        if (payload.vendor)
            payload.vendor = Object.fromEntries(Object.entries(payload.vendor).flatMap(([key, value]) => typeof value === "string" ? [[key, name(value, `/vendor/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`)]] : []));
        if (markers.length)
            payload.redactions = [markers[0], ...markers.slice(1)];
        return [{ event_type: "extension.used", actor: usage.trigger, payload }];
    });
}
