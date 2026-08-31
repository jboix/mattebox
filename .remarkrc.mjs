// remark formats the Markdown and checks its links. `pnpm run docs:check`
// fails on a broken link (files and heading anchors alike) or on a file
// that is not formatted; `pnpm run docs:format` rewrites the files.
import remarkGfm from 'remark-gfm';
import remarkValidateLinks from 'remark-validate-links';

export default {
  settings: {
    bullet: '-',
    emphasis: '_',
    strong: '*',
    fence: '`',
    rule: '-',
    listItemIndent: 'one',
  },
  plugins: [remarkGfm, remarkValidateLinks],
};
