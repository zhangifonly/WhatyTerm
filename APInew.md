# Chat Completions API

OpenAI 兼容的无状态聊天补全 API。

## 端点

```
POST /v1/chat/completions
```

## 特点

- **无状态**: 每次请求独立，不保留历史记录
- **OpenAI 兼容**: 请求/响应格式与 OpenAI API 一致
- **流式支持**: 支持 SSE (Server-Sent Events) 流式响应
- **图片理解**: 支持多模态消息，可发送图片进行视觉分析
- **Skills 支持**: 自动加载 `~/.claude/skills` 目录下的技能

## 请求

### Headers

```
Content-Type: application/json
```

### Body

| 字段 | 类型 | 必填 | 默认值 | 描述 |
|------|------|------|--------|------|
| `model` | string | 否 | `"opus"` | 模型名称 (`opus`, `sonnet`, `haiku`) |
| `messages` | array | 是 | - | 消息数组 |
| `stream` | boolean | 否 | `false` | 是否启用流式响应 |

### Messages 格式

#### 纯文本消息

```json
{
  "messages": [
    {"role": "user", "content": "你好"}
  ]
}
```

#### 多模态消息（图片+文本）

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图片里有什么？"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
          }
        }
      ]
    }
  ]
}
```

> 注意:
> - 当前实现只使用最后一条 user 消息作为 prompt
> - 图片必须使用 base64 data URL 格式（`data:image/png;base64,...`）
> - 支持的图片格式: PNG, JPEG, GIF, WebP

## 响应

### 非流式响应 (`stream: false`)

```json
{
  "id": "chatcmpl-bd821a9e",
  "object": "chat.completion",
  "created": 1764734297,
  "model": "opus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好！有什么我可以帮助你的吗？"
      },
      "finish_reason": "stop"
    }
  ]
}
```

### 流式响应 (`stream: true`)

返回 `text/event-stream` 格式的 SSE 流：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"opus","choices":[{"index":0,"delta":{"content":"你"}}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"opus","choices":[{"index":0,"delta":{"content":"好"}}]}

data: [DONE]
```

## 示例

### curl - 非流式

```bash
curl -X POST https://agent-ai.webtrn.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

### curl - 流式

```bash
curl -X POST https://agent-ai.webtrn.cn/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "messages": [{"role": "user", "content": "从1数到5"}],
    "stream": true
  }'
```

### Python - 图片理解

```python
import base64
import requests

# 读取图片并转换为 base64
with open("image.png", "rb") as f:
    image_data = base64.b64encode(f.read()).decode("utf-8")

response = requests.post(
    "https://agent-ai.webtrn.cn/v1/chat/completions",
    json={
        "model": "opus",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "描述这张图片"},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{image_data}"}
                }
            ]
        }],
        "stream": False
    }
)
print(response.json()["choices"][0]["message"]["content"])
```

### Python - 非流式

```python
import requests

response = requests.post(
    "https://agent-ai.webtrn.cn/v1/chat/completions",
    json={
        "model": "opus",
        "messages": [{"role": "user", "content": "你好"}],
        "stream": False
    }
)
print(response.json()["choices"][0]["message"]["content"])
```

### Python - 流式

```python
import requests

response = requests.post(
    "https://agent-ai.webtrn.cn/v1/chat/completions",
    json={
        "model": "opus",
        "messages": [{"role": "user", "content": "从1数到5"}],
        "stream": True
    },
    stream=True
)

for line in response.iter_lines():
    if line:
        line = line.decode("utf-8")
        if line.startswith("data: ") and line != "data: [DONE]":
            import json
            chunk = json.loads(line[6:])
            content = chunk["choices"][0]["delta"].get("content", "")
            print(content, end="", flush=True)
```

### JavaScript - 流式

```javascript
const response = await fetch("https://agent-ai.webtrn.cn/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "opus",
    messages: [{ role: "user", content: "你好" }],
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      const chunk = JSON.parse(line.slice(6));
      const content = chunk.choices[0].delta.content || "";
      process.stdout.write(content);
    }
  }
}
```

## 错误响应

### 400 Bad Request

```json
{
  "detail": "No message content provided"
}
```

### 500 Internal Server Error

```json
{
  "detail": "错误信息"
}
```

流式模式下的错误：

```
data: {"error": {"message": "错误信息"}}

data: [DONE]
```

## 配置

API 使用以下配置（通过环境变量设置）：

| 环境变量 | 默认值 | 描述 |
|----------|--------|------|
| `DEFAULT_MODEL` | `opus` | 默认模型 |
| `USE_USER_SETTINGS` | `true` | 是否使用 `~/.claude/settings.json` |
| `ANTHROPIC_API_KEY` | - | API 密钥（如果不使用用户配置） |
| `SKILLS_DIR` | `~/.claude/skills` | Skills 目录路径 |
