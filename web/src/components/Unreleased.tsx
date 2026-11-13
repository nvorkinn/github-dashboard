import { type Project, unreleasedUrl } from "../model.ts";
import { ExternalLink } from "./ExternalLink.tsx";

/**
 * Whether the default branch has changes that its latest release hasn't: how many commits, linking to GitHub's
 * comparison of the two, or that it is up to date. Nothing when that isn't known, such as without a release.
 */
export function Unreleased({ project }: { project: Project }) {
  const count = project.unreleased;
  const href = unreleasedUrl(project);
  const tag = project.latestRelease?.tag;
  if (count === undefined || href === undefined || tag === undefined) {
    return null;
  }
  const branch = project.defaultBranch ?? "the default branch";
  if (count === 0) {
    return (
      <span class="unreleased unreleased-none" title={`${tag} has everything on ${branch}`}>
        up to date
      </span>
    );
  }
  const commits = count === 1 ? "1 commit" : `${count} commits`;
  return (
    <ExternalLink
      href={href}
      class="chip tone-waiting unreleased"
      title={`${commits} on ${branch} since ${tag}, waiting for a release. Compare on GitHub.`}
    >
      {count} unreleased
    </ExternalLink>
  );
}
