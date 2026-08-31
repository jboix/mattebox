// Conventional Commits, enforced locally by the commit-msg hook and in CI on
// every pull request. semantic-release reads the same history, so the type
// is the version bump. A body is required: the subject is for the changelog,
// the body is where the reasoning lives.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-empty': [2, 'never'],
  },
};
