// size-limit discovers config via cosmiconfig at the repo root only;
// the real configuration lives in config/size-limit.cjs per the repo layout.
module.exports = require('./config/size-limit.cjs');
