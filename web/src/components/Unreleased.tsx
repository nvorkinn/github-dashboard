import { type Project, unreleasedUrl } from "../model.ts";
import { ExternalLink } from "./ExternalLink.tsx";

/**
 * Whether the default branch has changes that its latest release hasn't: how many pull requests, linking to GitHub's
 * comparison of the two, or that it is up to date. Commits are counted instead when none of them came in with a
 * pull request, or there are too many to tell. Nothing when that isn't known, such as without a release.
 */
export function Unreleased({ project }: { project: Project }) {
  const unreleased = project.unreleased;
  const href = unreleasedUrl(project);
  const tag = project.latestRelease?.tag;
  if (unreleased === undefined || href === undefined || tag === undefined) {
    return null;
  }
  const branch = project.defaultBranch ?? "the default branch";
  const { commits, pulls } = unreleased;
  if (commits === 0) {
    return (
      <span class="unreleased unreleased-none" title={`${tag} has everything on ${branch}`}>
        up to date
      </span>
    );
  }
  const counted = (count: number, one: string) => (count === 1 ? `1 ${one}` : `${count} ${one}s`);
  const inCommits = counted(commits, "commit");
  return (
    <ExternalLink
      href={href}
      class="chip tone-waiting unreleased"
      title={
        pulls
          ? `${counted(pulls, "pull request")} (${inCommits}) merged into ${branch} since ${tag}, waiting for a release. Compare on GitHub.`
          : `${inCommits} on ${branch} since ${tag}, waiting for a release. Compare on GitHub.`
      }
    >
      {pulls ? `${pulls} unreleased` : `${inCommits} unreleased`}
    </ExternalLink>
  );
}
