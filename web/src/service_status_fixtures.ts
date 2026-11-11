export const summaryFixture = () => ({
  page: { updated_at: "2026-11-11T12:00:00Z" },
  status: { indicator: "none", description: "All Systems Operational" },
  components: [{ id: "actions", name: "Actions", status: "operational", showcase: true }],
  incidents: [] as unknown[],
  scheduled_maintenances: [] as unknown[],
});
export const incidentFixture = () => ({
  id: "incident",
  name: "Test incident",
  status: "investigating",
  impact: "major",
  shortlink: "https://stspg.io/example",
  incident_updates: [
    { id: "update", status: "investigating", body: "API supplied update", display_at: "2026-11-11T12:00:00Z" },
  ],
});
