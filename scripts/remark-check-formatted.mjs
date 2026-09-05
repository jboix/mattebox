// Warns when a file differs from its formatted output; `--frail` makes that a failure.
export default function remarkCheckFormatted() {
  return (tree, file) => {
    if (this.stringify(tree, file) !== String(file)) {
      file.message('Not formatted. Run `pnpm run docs:format`.');
    }
  };
}
