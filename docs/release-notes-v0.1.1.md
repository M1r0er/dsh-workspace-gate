声明 DSH 运行时要求。

**变更**
- `package.json` 新增 `engines.dsh = ^0.2.1-rc.2`
- 版本号 `0.1.0 → 0.1.1`

**行为差异**
- 比 `0.2.1-rc.2` 更老的 DSH 会在**安装期**被插件管理器直接拒绝，并给出 `incompatible-version`，
  而不是装上以后在运行期才报错。
- 匹配范围包含 `0.2.1-rc.*`、`0.2.1`、以及 `0.2.x` 的非预发布版本；
  预发布版本只有同一 `0.2.1` 段才匹配（semver 的 prerelease 规则）。

**安装**
```bash
# GitHub（任何机器）
dsh plugin --profile <your-profile> add github:M1r0er/dsh-workspace-gate#v0.1.1

# npm（已发布 0.1.1）
dsh plugin --profile <your-profile> add dsh-workspace-gate@0.1.1
```
装完仍需在插件页启用 bundle。npm 页：https://www.npmjs.com/package/dsh-workspace-gate
