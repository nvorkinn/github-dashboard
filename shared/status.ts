/** Public Statuspage data, reduced to the fields the dashboard displays. No account data or credentials. */
export type ServiceTone = "operational" | "degraded" | "outage" | "maintenance" | "unknown";
export interface StatusComponent {
  id: string;
  name: string;
  status: string;
}
export interface StatusIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  url: string;
  scheduledFor: string | undefined;
  scheduledUntil: string | undefined;
  updates: { id: string; status: string; body: string; at: string }[];
}
export interface ServiceSummary {
  indicator: string;
  description: string;
  updatedAt: string;
  components: StatusComponent[];
  incidents: StatusIncident[];
  maintenance: StatusIncident[];
}
export interface StatusSnapshot {
  data?: ServiceSummary;
  /** Time of the last successful upstream read, rather than time of a cached response. */
  fetchedAt?: number;
  stale: boolean;
  error?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid status response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid status response");
  return value;
}
function date(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid status timestamp");
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid status response");
  return value;
}
function incident(value: unknown): StatusIncident {
  const item = object(value);
  const candidate = typeof item.shortlink === "string" ? item.shortlink : "https://www.githubstatus.com/";
  const url = new URL(candidate);
  return {
    id: string(item.id),
    name: string(item.name),
    status: string(item.status),
    impact: string(item.impact),
    url:
      url.protocol === "https:" && ["www.githubstatus.com", "stspg.io"].includes(url.hostname)
        ? url.href
        : "https://www.githubstatus.com/",
    scheduledFor: item.scheduled_for ? date(item.scheduled_for) : undefined,
    scheduledUntil: item.scheduled_until ? date(item.scheduled_until) : undefined,
    updates: list(item.incident_updates)
      .map((value) => {
        const update = object(value);
        return {
          id: string(update.id),
          status: string(update.status),
          body: string(update.body),
          at: date(update.display_at ?? update.created_at),
        };
      })
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  };
}

/** Reject malformed answers rather than accidentally claiming that GitHub is operational. */
export function parseServiceSummary(value: unknown): ServiceSummary {
  const data = object(value);
  const status = object(data.status);
  return {
    indicator: string(status.indicator),
    description: string(status.description),
    updatedAt: date(object(data.page).updated_at),
    components: list(data.components)
      .filter((value) => {
        const component = object(value);
        return component.showcase !== false && component.group !== true;
      })
      .map((value) => {
        const component = object(value);
        return { id: string(component.id), name: string(component.name), status: string(component.status) };
      }),
    incidents: list(data.incidents)
      .map(incident)
      .filter((item) => item.status !== "resolved"),
    maintenance: list(data.scheduled_maintenances)
      .map(incident)
      .filter((item) => item.status !== "completed"),
  };
}

export function componentTone(status: string): ServiceTone {
  switch (status) {
    case "operational":
      return "operational";
    case "degraded_performance":
    case "partial_outage":
      return "degraded";
    case "major_outage":
      return "outage";
    case "under_maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}

export function summaryTone(data: ServiceSummary): ServiceTone {
  const tones: ServiceTone[] = [
    ...data.components.map((component) => componentTone(component.status)),
    ...data.incidents.map(
      (item): ServiceTone => (item.impact === "critical" || item.impact === "major" ? "outage" : "degraded"),
    ),
  ];
  const indicator: Record<string, ServiceTone> = {
    none: "operational",
    minor: "degraded",
    major: "outage",
    critical: "outage",
    maintenance: "maintenance",
  };
  tones.push(indicator[data.indicator] ?? "unknown");
  if (data.maintenance.some((item) => ["in_progress", "verifying"].includes(item.status))) tones.push("maintenance");
  return ["outage", "degraded", "maintenance", "unknown", "operational"].find((tone) =>
    tones.includes(tone as ServiceTone),
  ) as ServiceTone;
}
