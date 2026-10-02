// Local redaction is final: nothing unredacted is persisted or uploaded (decision D4).
// Every pattern uses bounded or non-overlapping quantifiers so its cost stays
// linear in the input; tool output can be megabytes and hooks have a 3s budget.
export const MAX_STRING_LENGTH = 16_000;
// Scan a little past the cap so a secret straddling it is still recognized before truncation.
const SCAN_MARGIN = 1_024;
// Strings are cut to this length before scanning, so it also bounds every secret value:
// a value is masked to its real end, never to an arbitrary prefix.
const SCAN_LENGTH = MAX_STRING_LENGTH + SCAN_MARGIN;
export const REDACTED = "[REDACTED]";
// Names whose values are secrets: `DB_PASSWORD=`, `"api_key":`, `OPENAI_KEY:`, `x-auth-token`.
// Short words only count as whole name segments, so `monkey` and `author` stay visible.
const sensitiveName = /api[_.-]?key|token|secret|passw(?:or)?d|passphrase|authorization|cookie|credential|private[_.-]?key|access[_.-]?key|(?:^|[_.-])(?:key|pass|auth|dsn)(?:$|[_.-])/i;
/** Whether an object key or assignment name marks its value as secret. */
export function isSensitiveName(name) {
    return sensitiveName.test(name);
}
// A quoted value may be unterminated; its closing quote is optional.
const valuePattern = String.raw `(?:"[^"\n]{0,${SCAN_LENGTH}}"?|'[^'\n]{0,${SCAN_LENGTH}}'?|[^\s"']{1,${SCAN_LENGTH}})`;
const rules = [
    // PEM private keys. A block with no END line is redacted through the end of the string.
    [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
    // Prefixed tokens: Stripe-style sk_/rk_, GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_, npm_.
    [/\b(?:sk|rk|gh[pousr]|github_pat|npm)_[A-Za-z0-9_]{8,}/g, REDACTED],
    [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED], // OpenAI and Anthropic style, including sk-proj-
    [/\bignsight1_[A-Za-z0-9_-]{8,}/g, REDACTED], // Ignsight pairing tokens (see src/pairing-token.ts)
    [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED], // Slack
    [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED], // Google API key
    [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED], // AWS access key id
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED], // JWT
    [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
    // URL userinfo passwords, including DSNs: keep scheme, user and host for context.
    [/\b([a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@]{0,256}):[^\s/]{1,256}@/gi, `$1:${REDACTED}@`],
    // curl -u user:pass, curl --user=user:pass
    [new RegExp(String.raw `((?:^|\s)(?:-u\s*|--user(?:\s+|=))["']?[^\s:"']{1,256}):[^\s"']{1,${SCAN_LENGTH}}`, "g"), `$1:${REDACTED}`],
    // mysql -ppass (the password is attached to -p)
    [new RegExp(String.raw `(\b(?:mysql|mariadb)\w*\b[^\n]{0,512}?\s-p)(?=\S)${valuePattern}`, "g"), `$1${REDACTED}`],
    // Secret CLI flags with a space separator: --password pass, --token tok
    [new RegExp(String.raw `((?:^|\s)--?(?:password|passwd|pass|token|api-?key|secret|auth-token)\s+)${valuePattern}`, "gi"), `$1${REDACTED}`],
];
// Header-style names whose value is a list (`Cookie: a=1; b=2`): mask through the end of the line.
const headerName = /^(?:set-)?cookie$/i;
// Candidate `name=` / `name:` / `"name":` assignments, including CLI `--name=` and escaped JSON.
const assignment = /(?<![\w.-])-{0,2}(\\?["']?)([A-Za-z_][\w.-]{0,63})\1[ \t]*[=:](?![=:])[ \t]*/g;
/** Redact sensitive strings recursively, preserving numeric telemetry and bounded text. */
export function redact(value, key, sensitive = false) {
    sensitive = sensitive || Boolean(key && isSensitiveName(key));
    if (Array.isArray(value))
        return value.map((item) => redact(item, undefined, sensitive));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, sensitive)]));
    }
    if (typeof value === "string")
        return sensitive ? REDACTED : redactString(value);
    return value;
}
export const TRUNCATED_SUFFIX = "...[TRUNCATED]";
/** Mask secret spans in one string and bound its length. */
export function redactString(value) {
    const clean = redactText(value.slice(0, SCAN_LENGTH));
    return value.length > MAX_STRING_LENGTH || clean.length > MAX_STRING_LENGTH
        ? `${clean.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_SUFFIX}`
        : clean;
}
function redactText(text) {
    for (const [pattern, replacement] of rules)
        text = text.replace(pattern, replacement);
    return redactAssignments(text);
}
// A scanner rather than one regex: a non-sensitive name must not consume its value,
// so `env: OPENAI_KEY=...` still finds the inner assignment.
function redactAssignments(text) {
    let output = "";
    let copied = 0;
    assignment.lastIndex = 0;
    for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
        const name = match[2];
        if (!isSensitiveName(name))
            continue;
        const start = assignment.lastIndex;
        const end = valueEnd(text, start, headerName.test(name));
        if (end === start)
            continue;
        output += text.slice(copied, start) + maskValue(text.slice(start, end));
        copied = end;
        assignment.lastIndex = end;
    }
    return output + text.slice(copied);
}
// Where a secret value ends. Unterminated values run to the end of the line or text, and
// unquoted values end only at whitespace: shell and cookie punctuation (`&`, `;`) can be part
// of a secret, so over-masking the rest of a word is preferred to leaking its tail.
// The scanner resumes after the value, so the total scan stays linear.
function valueEnd(text, start, toLineEnd) {
    // Escaped JSON inside a string: \"value\"
    if (text.startsWith('\\"', start)) {
        const close = text.indexOf('\\"', start + 2);
        return close === -1 ? text.length : close + 2;
    }
    const quote = text[start];
    if (quote === '"' || quote === "'") {
        let index = start + 1;
        for (; index < text.length && text[index] !== "\n"; index++) {
            if (text[index] === "\\")
                index++;
            else if (text[index] === quote)
                return index + 1;
        }
        return Math.min(index, text.length);
    }
    if (toLineEnd) {
        const newline = text.indexOf("\n", start);
        return newline === -1 ? text.length : newline;
    }
    // `Authorization: Basic <credential>` keeps the scheme and masks the credential.
    const scheme = /^(?:Bearer|Basic|Token|Digest)[ \t]+/i.exec(text.slice(start, start + 16));
    let index = start + (scheme?.[0].length ?? 0);
    while (index < text.length && !/\s/.test(text[index]))
        index++;
    return index;
}
function maskValue(value) {
    if (value.startsWith('\\"'))
        return `\\"${REDACTED}\\"`;
    const quote = value[0];
    if (quote === '"' || quote === "'")
        return value.length > 1 && value.endsWith(quote) ? `${quote}${REDACTED}${quote}` : `${quote}${REDACTED}`;
    const scheme = /^(?:Bearer|Basic|Token|Digest)[ \t]+/i.exec(value)?.[0] ?? "";
    return `${scheme}${REDACTED}`;
}
