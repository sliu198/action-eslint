import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { CHECK_NAME, EXTENSIONS_TO_LINT } from './constants';
import { eslint } from './eslint-cli';

/**
 * This is just for syntax highlighting, does nothing
 * @param {string} s
 */
const gql = (s: TemplateStringsArray): string => s.join('');

async function run() {
  const octokit = new github.GitHub(
    core.getInput('repo-token', { required: true })
  );
  const context = github.context;

  const prInfo = await octokit.graphql(
    gql`
      query($owner: String!, $name: String!, $prNumber: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $prNumber) {
            commits(last: 1) {
              nodes {
                commit {
                  oid
                }
              }
            }
          }
        }
      }
    `,
    {
      owner: context.repo.owner,
      name: context.repo.repo,
      prNumber: context.issue.number
    }
  );

  const prFiles = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{prNumber}/files',
    {
      owner: context.repo.owner,
      repo: context.repo.repo,
      prNumber: context.issue.number
    }
  );


  const currentSha = prInfo.repository.pullRequest.commits.nodes[0].commit.oid;

  const filesToLint = prFiles.data
    .filter(f => EXTENSIONS_TO_LINT.has(path.extname(f.filename)) && f.status !== "removed")
    .map(f => f.filename);
  if (filesToLint.length < 1) {
    console.warn(
      `No files with [${[...EXTENSIONS_TO_LINT].join(
        ', '
      )}] extensions added or modified in this PR, nothing to lint...`
    );
    return;
  }

  let checkId;
  const givenCheckName = core.getInput('check-name');
  if (givenCheckName) {
    const checks = await octokit.checks.listForRef({
      ...context.repo,
      status: 'in_progress',
      ref: currentSha
    });
    const theCheck = checks.data.check_runs.find(
      ({ name }) => name === givenCheckName
    );
    if (theCheck) checkId = theCheck.id;
  }
  if (!checkId) {
    checkId = (await octokit.checks.create({
      ...context.repo,
      name: CHECK_NAME,
      head_sha: currentSha,
      status: 'in_progress',
      started_at: new Date().toISOString()
    })).data.id;
  }

  try {
    const { conclusion, output } = await eslint(filesToLint);
    const remainingAnnotations = [...output.annotations]
    let done = false;

    do {
      const annotations = remainingAnnotations.splice(0, 50);
      done = !!annotations.length;
      await octokit.checks.update({
        ...context.repo,
        check_run_id: checkId,
        completed_at: done ? new Date().toISOString() : undefined,
        conclusion: done ? conclusion : undefined,
        output: {
          ...output,
          annotations
        }
      });
    } while (remainingAnnotations.length);

    if (conclusion === 'failure') {
      core.setFailed(`ESLint found some errors`);
    }
  } catch (error) {
    await octokit.checks.update({
      ...context.repo,
      check_run_id: checkId,
      conclusion: 'failure',
      completed_at: new Date().toISOString()
    });
    core.setFailed(error.message);
  }
}

run();
