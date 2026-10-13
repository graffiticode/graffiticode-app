const enabled = !!process.env.RAG_DEBUG;

const MAX_STRING_LENGTH = 300;
const SENSITIVE_KEYS = ["api_key", "apiKey", "token", "password", "secret"];

function safe(data: any): any {
  if (typeof data === "string") {
    return data.length > MAX_STRING_LENGTH
      ? data.substring(0, MAX_STRING_LENGTH) + "...[truncated]"
      : data;
  }

  if (Array.isArray(data)) {
    return data.map(safe);
  }

  if (data && typeof data === "object") {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (
        SENSITIVE_KEYS.some((sensitive) =>
          key.toLowerCase().includes(sensitive),
        )
      ) {
        cleaned[key] = "[REDACTED]";
      } else {
        cleaned[key] = safe(value);
      }
    }
    return cleaned;
  }

  return data;
}

export const ragLog = (rid: string, stage: string, data?: any) => {
  if (!enabled) return;

  const timestamp = new Date().toISOString();
  const safeData = data !== undefined ? safe(data) : {};

  console.log(
    JSON.stringify({
      timestamp,
      type: "RAG",
      rid,
      stage,
      ...safeData,
    }),
  );
};

export const generateRequestId = () => {
  return crypto.randomUUID();
};
