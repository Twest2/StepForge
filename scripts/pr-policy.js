'use strict';

/**
 * Rules every pull request from outside contributors must meet, checked by
 * .github/workflows/pr-policy.yml when it is opened, reopened or marked
 * ready for review. A pull request that misses any is closed with a comment
 * that lists what to fix, and its author opens a new one.
 *
 * It must:
 *  - allow edits by maintainers (when the fork belongs to a person; GitHub
 *    offers no such option for organization-owned forks), and
 *  - roughly follow .github/PULL_REQUEST_TEMPLATE.md: the Issue, Summary,
 *    Changes, Testing and Checklist sections, with an issue linked and
 *    something written in Summary, Changes and Testing. Area, Screenshots
 *    and Rollout notes may be left out, as the template says.
 *
 * Maintainers (owner, members, collaborators) and bots are not checked.
 */

const EXEMPT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const REQUIRED_SECTIONS = ['Issue', 'Summary', 'Changes', 'Testing', 'Checklist'];
const TEMPLATE_URL = 'https://github.com/Twest2/StepForge/blob/main/.github/PULL_REQUEST_TEMPLATE.md';
const CONTRIBUTING_URL = 'https://github.com/Twest2/StepForge/blob/main/docs/CONTRIBUTING.md';

/** The body without template comments, in `## Heading` -> text sections. */
function sections(body) {
  const text = String(body || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const found = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      current = heading[1].trim().toLowerCase();
      if (!found.has(current)) found.set(current, []);
    } else if (current) {
      found.get(current).push(line);
    }
  }
  return new Map([...found].map(([name, lines]) => [name, lines.join('\n').trim()]));
}

/** Lines that say something: not blank, not an empty bullet, not an unticked template box. */
function meaningfulLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter((line) => line
    && !/^[-*+]\s*$/.test(line)
    && !/^[-*+]\s*\[ \]/.test(line));
}

const linksIssue = (text) => /(^|[^\w&])#\d+\b/.test(text) || /github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/i.test(text);

/**
 * `pr` is the pull_request object from the webhook payload.
 * Returns { exempt, problems: [text for the closing comment] }.
 */
function checkPullRequest(pr) {
  if (!pr) return { exempt: true, problems: [] };
  if (pr.user?.type === 'Bot' || EXEMPT_ASSOCIATIONS.has(pr.author_association)) return { exempt: true, problems: [] };
  const problems = [];

  const fromFork = pr.head?.repo?.full_name && pr.head.repo.full_name !== pr.base?.repo?.full_name;
  const personalFork = pr.head?.repo?.owner?.type !== 'Organization';
  if (fromFork && personalFork && pr.maintainer_can_modify !== true) {
    problems.push('**Allow edits by maintainers** is not turned on. Tick it when you open the pull request, so maintainers can push small fixes to your branch.');
  }

  const found = sections(pr.body);
  const missing = REQUIRED_SECTIONS.filter((name) => !found.has(name.toLowerCase()));
  if (missing.length) {
    problems.push(`The description is missing the ${missing.map((name) => `**${name}**`).join(', ')} section${missing.length > 1 ? 's' : ''} from the pull request template.`);
  }
  if (found.has('issue') && !linksIssue(found.get('issue'))) {
    problems.push('The **Issue** section does not link an issue. Write `Closes #123` with the number of the issue this fixes (open one first if there isn’t one).');
  }
  for (const name of ['Summary', 'Changes', 'Testing']) {
    if (found.has(name.toLowerCase()) && !meaningfulLines(found.get(name.toLowerCase())).length) {
      problems.push(`The **${name}** section is empty.`);
    }
  }
  return { exempt: false, problems };
}

/** The comment posted before closing: what was wrong, and to open a new pull request. */
function closingComment(problems) {
  return [
    'Thanks for the pull request! It has been closed automatically because it does not meet this repository’s requirements for pull requests:',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    `Please open a new pull request that fixes ${problems.length > 1 ? 'these' : 'this'}. Use the [pull request template](${TEMPLATE_URL}) (it fills in when you open a pull request) and see [CONTRIBUTING.md](${CONTRIBUTING_URL}) for what reviewers look for. Your branch is untouched, so you can open the new pull request from it.`,
  ].join('\n');
}

module.exports = { checkPullRequest, closingComment, sections, REQUIRED_SECTIONS };
