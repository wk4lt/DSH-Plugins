# Bundled runtime dependencies

- `zod@4.6.7` is distributed under the MIT license in `zod.LICENSE`.
- `yaml@2.9.1` is distributed under the ISC license in `yaml.LICENSE`.

The plugin imports `agent-dependencies.js` from the package. The generated ESM bundle includes the two npm packages and uses Node's built-ins for YAML's Node entry point.

To regenerate the bundle and license copies, run these commands from `plugins/software-workflow` in a POSIX shell. Update the pinned versions here and in the bundle banner when upgrading.

```sh
vendor_dir="$PWD/vendor"
work_dir=$(mktemp -d)
npm install --prefix "$work_dir" --no-save --no-package-lock --ignore-scripts \
  esbuild@0.27.0 zod@4.6.7 yaml@2.9.1
(
  cd "$work_dir"
  printf '%s\n' "export { z } from 'zod';" \
    "export { LineCounter, parseDocument, visit } from 'yaml';" |
    node_modules/.bin/esbuild --bundle --format=esm --platform=node --legal-comments=eof \
      --banner:js="// Generated from zod@4.6.7 and yaml@2.9.1. See VENDOR.md.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);" \
      --outfile="$vendor_dir/agent-dependencies.js"
  cp node_modules/zod/LICENSE "$vendor_dir/zod.LICENSE"
  cp node_modules/yaml/LICENSE "$vendor_dir/yaml.LICENSE"
)
```
