import fs from "node:fs";

export function safeJson(value) {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nestedValue) => {
        if (typeof nestedValue === "bigint") {
          return nestedValue.toString();
        }

        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack
          };
        }

        if (typeof nestedValue === "function") {
          return `[Function ${nestedValue.name || "anonymous"}]`;
        }

        return nestedValue;
      })
    );
  } catch {
    return String(value);
  }
}

export function createLogger({ logFile }) {
  return {
    append(entry) {
      try {
        const payload = safeJson({
          ts: new Date().toISOString(),
          ...entry
        });
        fs.appendFileSync(logFile, `${JSON.stringify(payload)}\n`, "utf8");
      } catch (error) {
        console.error("[guardrail-spike] failed to append JSONL log", error);
      }
    }
  };
}
