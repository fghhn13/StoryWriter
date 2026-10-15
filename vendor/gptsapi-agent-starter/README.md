# GPTsAPI agent starter

让 agent 快速了解 GPTsAPI 中转接口的最小仓库：先读 [AGENTS.md](AGENTS.md)，再运行零依赖 Python 客户端。

## 模型优先级

推荐优先级：**Opus 5.5 > GPT-6.1 Sol > GPT-6 Luna**。

其他备选：**Grok 4.5、DeepSeek 4.1 Pro**。调用前运行 `python api.py models` 确认准确的模型 ID 和是否在列表中。

## 三步上手

需要 Python 3.10+，无需 `pip install`。

1. 将 `.env.example` 复制为 `.env`，填入自己的 `GPTSAPI_API_KEY`。
2. 执行 `python api.py models`，确认账号返回的模型 ID。
3. 执行 `python api.py smoke`，测试一次最小对话，预期返回 `OK`。

```powershell
Copy-Item .env.example .env
# 在编辑器中填写 .env 的密钥
python api.py models
python api.py smoke
python api.py chat "用一句话解释什么是 API"
```

也可以直接读取已有的配置文件，无需复制密钥：

```powershell
python api.py --env-file "F:\path\credentials.env" --base-url https://api2.gptsapi.net/v1 smoke
```

支持两种配置格式：

```dotenv
GPTSAPI_BASE_URL=https://api2.gptsapi.net/v1
GPTSAPI_API_KEY=sk-your-key-here
GPTSAPI_MODEL=claude-opus-5-5
```

```text
Base URL: https://api2.gptsapi.net
API Key: sk-your-key-here
Model: claude-opus-5-5
```

优先级：命令行的地址/模型参数 > 同名进程环境变量 > 配置文件 > 默认地址/模型。默认读取当前工作目录的 `.env`；指定的文件不存在时会报错。地址末尾没有 `/v1` 时脚本自动补齐；密钥没有默认值。

## 请求格式

| 项目 | 值 |
| --- | --- |
| 本机实测可用的 Base URL | `https://api2.gptsapi.net/v1` |
| 服务方教程提供的 Base URL | `https://api.gptsapi.net/v1` |
| 鉴权 | `Authorization: Bearer <API_KEY>` |
| 模型列表 | `GET /v1/models`，读取 `data[].id` |
| 文本对话 | `POST /v1/chat/completions` |
| 实测模型 ID | `claude-opus-5-5` |
| 读取回答 | `choices[0].message.content` |

最小对话请求体：

```json
{
  "model": "claude-opus-5-5",
  "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
  "max_tokens": 16,
  "stream": false
}
```

Claude 模型在这里通过中转站的 OpenAI 兼容聊天端点调用。不要据此假定完整的 OpenAI 或 Anthropic API 都兼容。模型列表与响应中的模型名属于中转站声明，本测试没有验证其上游模型身份。

## 客户端行为

- `models`：仅查询模型列表。
- `smoke`：发送一次上述最小对话；回答去掉首尾空白后必须为 `OK`，否则退出码为 1。
- `chat "内容"`：发送普通对话，默认最多 128 输出 tokens，可用 `--max-tokens 256` 调整。
- 输出为 JSON；包含模型、回答、usage 和耗时。错误写到 stderr，退出码为 1。
- 默认超时 45 秒，可用全局参数 `--timeout 60` 调整。全局参数放在子命令之前。
- 不自动重试。对话请求可能产生中转站费用，价格以账号后台为准。

## 实测记录

2026-10-10，使用用户本地密钥，未将密钥写入本仓库：

| 测试 | 结果 |
| --- | --- |
| `api.gptsapi.net` | 本机发生连接重置；另一次复测 DNS 解析失败，未得到鉴权结果 |
| `api2.gptsapi.net`，Python 默认 User-Agent | HTTP 403，Cloudflare `error code: 1010` |
| `api2.gptsapi.net`，浏览器 User-Agent，模型列表 | HTTP 200，46 个模型，包含配置模型 |
| 同地址、同 User-Agent，`claude-opus-5-5` 非流式对话 | HTTP 200，回答 `OK`；约 2.58 秒；usage 为输入 42、输出 4、合计 46 tokens |

以上是本机当时的结果，不保证其他网络、账号或之后的模型列表相同。脚本默认使用实测成功的地址和 User-Agent。

本仓库的 `api.py` 也已于同日直接验证：`models` 返回 HTTP 200 / 46 个模型；`smoke` 返回 HTTP 200 / `OK` / `passed: true`，约 0.66 秒、46 tokens。

## 常见错误

| 现象 | 下一步 |
| --- | --- |
| DNS 失败、连接重置、超时 | 检查网络与配置域名；尚未收到 HTTP 响应，不能据此判定密钥无效 |
| HTTP 403，Cloudflare 1010 | 检查 User-Agent / 站点防火墙；脚本内置当时实测成功的浏览器 User-Agent，也可用 `GPTSAPI_USER_AGENT` 覆盖 |
| HTTP 401 或鉴权类 JSON 错误 | 在站点后台检查密钥有效性与权限 |
| 模型不存在或不可用 | 运行 `models`，使用返回的准确 ID；再检查账号模型权限 |
| HTTP 429 | 检查限流/余额等服务方错误详情；等待后手动重试 |
| URL 出现 `/v1/v1` | Base URL 应为站点根地址或只带一个 `/v1`，不能填完整聊天路径 |

当前验证范围仅为模型列表与非流式文本对话。流式响应、工具调用、图片、Responses API、Anthropic 原生端点尚未验证。

## 文件

- [AGENTS.md](AGENTS.md)：agent 的快速入口与操作约束。
- [api.py](api.py)：可执行且可导入的最小客户端。
- [.env.example](.env.example)：占位配置。
- [.gitignore](.gitignore)：忽略真实配置和 Python 临时文件。

服务方教程：[GPTsAPI 使用教程](https://api2.gptsapi.net/tutorial)。接口与模型随服务方更新，以实时查询和实际响应为准。
