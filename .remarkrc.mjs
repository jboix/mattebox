// Markdown formatting and link checks: `pnpm run docs:check`, `pnpm run docs:format`.
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
