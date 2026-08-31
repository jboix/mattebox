// A remark plugin for `pnpm run docs:check`: warns when a file's formatted
// output differs from its source, so `--frail` fails the run until
// `pnpm run docs:format` has been run.
export default function remarkCheckFormatted() {
  return (tree, file) => {
    if (this.stringify(tree, file) !== String(file)) {
      file.message('Not formatted. Run `pnpm run docs:format`.');
    }
  };
}
