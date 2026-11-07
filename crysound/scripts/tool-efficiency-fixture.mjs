// node crysound/scripts/tool-efficiency-fixture.mjs <new empty benchmark directory>
// Only synthetic inputs; run each task in a fresh session with the task's cwd.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error("用法：tool-efficiency-fixture.mjs <新建的基准目录>");
const root = resolve(directory);
await mkdir(root); // Refuse to overwrite prior evidence or an existing workspace.
for (const name of ["question", "read", "script"]) await mkdir(join(root, name));
for (let index = 1; index <= 20; index++) {
  const id = String(index).padStart(2, "0");
  await writeFile(join(root, "read", `job-${id}.mjs`), `export const job = {
  id: "job-${id}",
  limit: ${index * 3},
  enabled: ${index % 7 !== 0},
  retry: ${index % 3},
  description: "Synthetic task ${id}",
};
`);
}
await writeFile(join(root, "script/input.csv"), "id,amount\na,125\nb,375\nc,-200\nd,950\ne,250\n");
await writeFile(join(root, "cases.json"), JSON.stringify([
  {
    id: "question", cwd: "question",
    prompt: "6 乘以 7 等于多少？只回答数字。",
    expected: "42",
  },
  {
    id: "read", cwd: "read",
    prompt: "检查当前目录的全部 20 个 job 模块。请回答：所有 limit 的总和、enabled 为 false 的模块文件名、只计 enabled 为 true 时 limit 的总和。依据文件内容回答，不运行这些模块。",
    expected: { total: 630, disabled: ["job-07.mjs", "job-14.mjs"], enabledTotal: 567 },
  },
  {
    id: "script", cwd: "script",
    prompt: "在当前目录写一个 Python 标准库脚本 stats.py，读取 input.csv 的 amount 列，输出含 count 和 sum 的 JSON。运行脚本并核对实际输出，不修改输入文件。",
    expected: { count: 5, sum: 1500 },
  },
], null, 2) + "\n");
console.log(join(root, "cases.json"));
