import { expect, test } from "vitest";
import { componentTone, parseServiceSummary, summaryTone } from "../../shared/status.ts";

import { incidentFixture, summaryFixture } from "./service_status_fixtures.ts";

test("maps component and overall status without hiding affected components", () => {
  expect(componentTone("partial_outage")).toBe("degraded");
  expect(componentTone("major_outage")).toBe("outage");
  expect(componentTone("under_maintenance")).toBe("maintenance");
  expect(componentTone("new_status")).toBe("unknown");
  const fixture = summaryFixture();
  expect(summaryTone(parseServiceSummary(fixture))).toBe("operational");
  fixture.components = [{ id: "actions", name: "Actions", status: "major_outage", showcase: true }];
  expect(summaryTone(parseServiceSummary(fixture))).toBe("outage");
});
test("keeps incident text and timestamps and distinguishes upcoming and active maintenance", () => {
  const fixture = summaryFixture();
  fixture.incidents = [incidentFixture()];
  const data = parseServiceSummary(fixture);
  expect(data.incidents[0]?.updates[0]?.body).toBe("API supplied update");
  expect(summaryTone(data)).toBe("outage");
  fixture.incidents = [];
  fixture.scheduled_maintenances = [
    { ...incidentFixture(), status: "scheduled", scheduled_for: "2026-11-12T12:00:00Z" },
  ];
  expect(summaryTone(parseServiceSummary(fixture))).toBe("operational");
  fixture.scheduled_maintenances = [{ ...incidentFixture(), status: "in_progress" }];
  expect(summaryTone(parseServiceSummary(fixture))).toBe("maintenance");
});
test("rejects incomplete data and unsafe incident links", () => {
  expect(() => parseServiceSummary({ status: { indicator: "none" } })).toThrow();
  const fixture = summaryFixture();
  fixture.incidents = [{ ...incidentFixture(), shortlink: "javascript:alert(1)" }];
  expect(parseServiceSummary(fixture).incidents[0]?.url).toBe("https://www.githubstatus.com/");
});
