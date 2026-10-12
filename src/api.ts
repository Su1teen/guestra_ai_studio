import type {
  Client,
  Conversation,
  Agent,
  Prompt,
  Scenario,
  Annotation,
  Call,
  ScenarioRun,
  Message,
  Attempt,
  Run,
  Role,
  Mode,
} from "../shared/domain";
export interface Bootstrap {
  user: { userId: string; name: string; role: Role; workspaceId: string };
  workspace: { id: string; name: string; mode: Mode; environment: string };
  clients: Client[];
  conversations: Conversation[];
  agents: Agent[];
  prompts: Prompt[];
  scenarios: Scenario[];
  calls: Call[];
  annotations: Annotation[];
  scenarioRuns: ScenarioRun[];
  database: string;
}
export interface Timeline {
  conversation: Conversation;
  messages: Message[];
  attempts: Attempt[];
  runs: Run[];
  annotations: Annotation[];
  calls: Call[];
  connectionError?: string;
  cached: boolean;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Сервер пока недоступен. Повторите через несколько секунд.",
    );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "Ошибка запроса");
  return result as T;
}
export function upload(
  file: File,
  onProgress: (value: number) => void,
): Promise<{
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "video" | "document";
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader(
      "X-File-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        xhr.status < 300
          ? resolve(result)
          : reject(new Error(result.error?.message ?? "Загрузка не удалась"));
      } catch {
        reject(new Error("Загрузка не удалась"));
      }
    };
    xhr.onerror = () => reject(new Error("Соединение прервано"));
    xhr.send(file);
  });
}
export const stageLabels: Record<string, string> = {
  new_contact: "Первое обращение",
  known_customer: "Известный клиент",
  commercial_request: "Коммерческий запрос",
  enquire: "Enquire",
  tentative: "Tentative",
  definite: "Готов оплатить",
  pending_payment: "Ожидает оплаты",
  confirmed: "Подтверждённая бронь",
  pre_arrival: "До заезда",
  in_house: "Во время проживания",
  service_only: "Только услуги",
  post_stay: "После выезда",
  returning_guest: "Повторный гость",
};
export const modeLabels: Record<Mode, string> = {
  preview: "Local Preview",
  crm: "CRM Connected",
  sandbox: "End-to-End Sandbox",
};
export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
export const initials = (name: string) =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
