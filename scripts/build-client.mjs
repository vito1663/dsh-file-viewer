// 客户端产物=文件源码直接拷贝（全内联样式，无需 CSS 注入）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'client/client.src.js'), 'utf8');
if (src.includes('@@STYLES@@')) throw new Error('client.src.js 里不应再有 @@STYLES@@ 占位（已改内联样式）');
writeFileSync(join(root, 'client/client.js'), src);
console.log(`client/client.js 已生成：${src.length} 字符（内联样式）`);
