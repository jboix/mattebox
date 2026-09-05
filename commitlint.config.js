// Conventional Commits: the type drives the semantic-release version bump.
// A body is required.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-empty': [2, 'never'],
  },
};
