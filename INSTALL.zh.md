# 安装指南（官方 DSH CLI）

本插件以 DSH **bundle** 形式发布：一份 `dsh` 声明的 patch 层 + 一份客户端半侧。请用官方 `dsh plugin`
命令安装，它会把 profile 依赖、lockfile 与 `dsh.profile.bundles` 层栈一起更新。不要用普通
`npm install`、在 profile 里直接 `pnpm add`，或手工编辑 profile 清单来替代它。

- [安装指南](./INSTALL.zh.md)
- [English installation guide](./INSTALL.md)
- [中文 README](./README.zh.md)
- [English README](./README.md)
- [更新日志](./CHANGELOG.md)

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | 22.19+ 或 24+ |
| DSH | `engines.dsh` 与 peer 范围里列出的 rc（截至 `0.2.1-rc.3`）之一 |
| 包管理器 | pnpm 11——随 `dsh` CLI 提供，无需另装 |

```bash
echo "DSH_HOME=${DSH_HOME:-$HOME/.dsh}"
dsh --version
ls "${DSH_HOME:-$HOME/.dsh}/profiles"
```

请使用**正在运行的那个 DSH 进程**所用的 profile。常见的是 `web`；以实际 `--profile` 参数为准。

> 如果已经装了上游 `dsh-thinking-levels`，先卸掉——两个插件会为同一个请求注入 `reasoningEffort`，只会互相打架。

## 1. 安装

**从 npm 安装（推荐，`lib/` 已构建）：**

```bash
dsh plugin --profile web add dsh-auto-reasoning-effort -w
```

`-w` 是必需的，因为 `web` profile 本身是 pnpm workspace 根。需要可复现安装时钉版本：

```bash
dsh plugin --profile web add dsh-auto-reasoning-effort@0.1.0 -w
```

**从 GitHub 源码安装（会执行包里的 `prepare` 脚本）：**

```bash
dsh plugin --profile web add github:lion231226/dsh-auto-reasoning-effort -w
```

pnpm ≥ 10 默认拦截 git 依赖的构建脚本。第一次执行会告诉你哪个包需要放行，把它写进 profile 的
`pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-auto-reasoning-effort: true
```

只对可信来源这么做，并尽量钉住 commit（`github:lion231226/dsh-auto-reasoning-effort#<sha>`）。
从 npm 或 tarball 安装可以完全避开构建步骤。

**从 tarball 安装（离线环境）：**

```bash
pnpm pack                       # 产出 dsh-auto-reasoning-effort-0.1.0.tgz
dsh plugin --profile web add ./dsh-auto-reasoning-effort-0.1.0.tgz -w
```

**从 dsh-market 安装（图形界面）：** 打开插件市场，搜索 `dsh-auto-reasoning-effort` 安装。
若条目尚未收录，用上面任一命令行方式。

## 2. 重启

正在运行的宿主不会热加载新的 bundle 层：

```bash
dsh web
```

随后刷新 Web 页面，让客户端半侧也生效。

## 3. 验证

检查依赖与已装版本：

```bash
grep -n "dsh-auto-reasoning-effort" \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json"
node -p "require('${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auto-reasoning-effort/package.json').version"
# 期望输出：0.1.0
```

检查组合行：

```bash
dsh --profile web --dump-config | grep -n -A2 "dsh-auto-reasoning-effort"
```

组合里必须有这一行（`name: dsh-auto-reasoning-effort`）。启动输出里若出现
`patch: entry <id> not found`，说明某个配置覆盖指向了已不存在的行。

检查设置表单：**Settings → Plugins → dsh-auto-reasoning-effort** 应显示启用开关、档位选择器与调度开关
——这些字段由宿主根据插件的 `.volatile()` schema 生成。

检查运行时：在会话模型选择器里选 **Auto**，发一条请求，日志里会出现调度行——包含模型、难度、分数、
命中理由与最终档位。手动选档时不会出现调度行（调度器按设计让路）。

## 4. 升级 / 卸载

```bash
# 升级
dsh plugin --profile web update dsh-auto-reasoning-effort -w

# 卸载
dsh plugin --profile web remove dsh-auto-reasoning-effort -w
```

两种操作之后都要重启宿主。

## 5. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm 11 对新发布版本有供应链冷却期 | 在 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加上 `dsh-auto-reasoning-effort@0.1.0` |
| `installation rejected: … is incompatible with dsh <version>` | 当前 DSH 不在声明的 peer 范围内 | 升级到受支持的 rc，或授予精确版本豁免：`dsh plugin --profile web allow-version dsh-auto-reasoning-effort@0.1.0 --dsh-version <version> --accept-risk` |
| 安装命令抱怨 workspace 根 | 少了 `-w` | 在命令末尾加 `-w` |
| git 安装卡在构建脚本被拦截 | pnpm 没有执行 `prepare` | 在 `allowBuilds` 里放行（见 §1），或改用 npm / tarball |
| 装好了但模型面板没有 Auto | 客户端半侧没加载，或该模型不广告任何推理档位 | 确认组合行存在、刷新页面，再检查 `models` 能力覆盖 |
| 档位频繁跳动 | 难度启发式被关键词触发 | 调大 `hysteresisSteps`、钉死档位，或精简关键词表 |

## 6. 相关链接

- [README](./README.zh.md) · [English README](./README.md) — 算法、配置、已知限制
- [更新日志](./CHANGELOG.md)
- [NOTICE](./NOTICE) — fork 来源与作者归属划分
- 上游项目：[drscrewdriver/dsh-thinking-levels](https://github.com/drscrewdriver/dsh-thinking-levels)
