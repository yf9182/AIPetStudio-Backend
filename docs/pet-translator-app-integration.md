# 宠物双向翻译 App 接入文档

本文面向 iOS 客户端，描述 Worker 的宠物翻译接口和客户端接入方式。接口当前只支持 `zh-CN`，录音上传后由 Worker 调用 Gemini；人→宠物不会生成新音频，而是从服务端审核通过的猫狗声音库中匹配一条录音并返回短期播放地址。

后端接口实现以 [README.md](../README.md) 和 Worker 源码为准。本文只涉及 App 接入，不包含生产部署和供应商密钥。

## 1. 接入前提

App 使用现有的 `WorkerAPIClient`、`SessionStore`、`AppStore` 和 `AppConfig.workerBaseURL`。Worker 默认地址为：

```text
https://ai-pet-studio-backend.yangf999212.workers.dev
```

必须满足以下条件：

- App 启动后已经完成 Worker session bootstrap，并保存 `access_token`、`refresh_token` 和 `customer_id`。
- 除 bootstrap、refresh 外，请求都带 `Authorization: Bearer <access_token>`。
- Worker 开启 App Check 后，请求还必须带 `X-Firebase-AppCheck: <token>`。当前开发环境通常为 disabled，Release 验收必须按 required 模式验证。
- 录音使用 M4A/AAC、MP3 或 WAV，单文件不超过 10 MiB，时长不超过 15 秒。推荐单声道 M4A/AAC。
- 每个新的录音请求生成一个 UUID `X-Request-ID`。同一录音的网络重试必须复用它，不能为同一录音生成新的任务。

翻译请求最长可能等待 60 秒。翻译专用 `URLRequest` 的 `timeoutInterval` 应设置为至少 70 秒；任务查询可以继续使用普通请求超时。

## 2. 会话和鉴权

启动流程沿用现有 App 流程：

```text
读取或生成稳定 device_id
  → POST /v1/session/bootstrap
  → 保存 access_token、refresh_token、customer_id
  → 用 customer_id 配置 RevenueCat
  → 调用翻译接口
```

bootstrap 请求不需要 JWT：

```http
POST /v1/session/bootstrap
Accept: application/json
Content-Type: application/json

{"device_id":"<stable-device-id>"}
```

响应：

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "customer_id": "aipet_<device-id>",
  "expires_in": 3600
}
```

翻译请求示例请求头：

```http
Authorization: Bearer <access_token>
X-Firebase-AppCheck: <app-check-token>
X-Request-ID: 550e8400-e29b-41d4-a716-446655440000
Accept: application/json
Content-Type: multipart/form-data; boundary=...
```

收到 `401 UNAUTHORIZED` 时，客户端先使用 refresh token 请求 `/v1/session/refresh`，失败后重新 bootstrap 一次，再用相同的 `X-Request-ID` 重试。收到 `401 APP_CHECK_REQUIRED` 时，应刷新 App Check token 后重试；不要通过删除或更换请求 ID 绕过鉴权。

## 3. 接口和 multipart 请求

| 方向 | 方法和路径 | 说明 |
| --- | --- | --- |
| 宠物→人 | `POST /v1/pet-translator/pet-to-human` | 识别宠物叫声，返回情绪、意图和拟人化表达 |
| 人→宠物 | `POST /v1/pet-translator/human-to-pet` | 识别人声含义和情绪，返回匹配的预置猫狗录音 |
| 查询任务 | `GET /v1/pet-translator/tasks/{task_id}` | 一次性查看任务或刷新 `audio_url`；不做定时轮询 |
| 播放音频 | `GET /v1/pet-translator/audio/{task_id}?token=...` | 使用响应中的 `audio_url`，支持 Range |

表单字段只能使用以下三个字段：

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `audio` | 文件 | 是 | 实际可解析的 WAV、MP3、AAC 或 M4A 音频 |
| `species` | 字符串 | 是 | `cat` 或 `dog` |
| `language` | 字符串 | 否 | 仅 `zh-CN`，省略时按 `zh-CN` 处理 |

文件字段名必须是 `audio`，不能沿用图片上传接口的 `file`。服务端会检查文件头、音轨、声道和时长，不信任扩展名或客户端 MIME 声明。请求中不要上传转写文本，也不要上传 `sound_prompt`。

curl 形式：

```sh
curl -X POST "$WORKER/v1/pet-translator/human-to-pet" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Request-ID: 550e8400-e29b-41d4-a716-446655440000" \
  -F "audio=@message.m4a;type=audio/mp4" \
  -F "species=cat" \
  -F "language=zh-CN"
```

## 4. 成功响应

成功响应沿用 Worker 的 `code/message/data` 包装：

新任务完成时 POST 返回 HTTP `201`，且 `data.state` 必须是 `succeeded`；使用同一个请求 ID 重试并复用已保存结果时返回 HTTP `200`，且同样只返回终态。客户端应将两者都视为成功，不要根据状态码重新创建任务。

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "task_id": "task-uuid",
    "direction": "HUMAN_TO_PET",
    "species": "cat",
    "language": "zh-CN",
    "state": "succeeded",
    "phase": "completed",
    "is_valid": true,
    "transcript": "宝宝，我回来啦",
    "meaning": "主人开心地向宠物打招呼",
    "emotion": "affectionate",
    "intensity": "medium",
    "audio_url": "https://worker.example/v1/pet-translator/audio/task-uuid?token=<signed-token>",
    "sound_id": "cat-affectionate-02",
    "sound_emotion": "affectionate",
    "sound_intensity": "medium",
    "audio_duration_seconds": 4.2,
    "sound_library_version": "v1",
    "credit_cost": 10,
    "debit_status": "confirmed",
    "refund_status": "none",
    "created_at": "2026-09-08T03:00:00.000Z",
    "updated_at": "2026-09-08T03:00:02.000Z",
    "expires_at": "2026-09-15T03:00:00.000Z"
  }
}
```

### 公共字段

- `task_id`：服务端任务 ID，提交成功后立即持久化到本地恢复状态。
- `state`：`reserved`、`processing`、`succeeded`、`failed` 或 `expired`。
- `phase`：例如 `billing`、`gemini`、`sound_matching`、`refund_pending`、`completed`。
- `is_valid`：是否检测到有效的目标声音。无有效声音时为 `false`，不会返回播放地址。
- `debit_status` / `refund_status`：显示积分最终状态；退款未确认时不要把任务当作完全完成。

### 宠物→人字段

`emotion`、`intent`、`translation`、`confidence`、`explanation` 位于 `data` 中。`confidence` 为 `low`、`medium` 或 `high`。这是一种保守的娱乐性推测，不是逐句翻译，也不代表宠物真的理解或表达了对应人类句子。

### 人→宠物字段

- `transcript`：人声转写。
- `meaning`：人声的简短含义。
- `emotion`：固定枚举：`happy`、`excited`、`affectionate`、`calm`、`curious`、`play_invitation`、`attention_seeking`、`displeased`、`afraid`、`alert`。
- `intensity`：`low`、`medium` 或 `high`。
- `audio_url`：匹配录音的短期签名地址。
- `sound_id` / `sound_library_version`：用于日志和问题定位，不要拼接或改写为播放地址。
- `sound_emotion` / `sound_intensity` / `audio_duration_seconds`：实际播放素材的元数据。

客户端只播放服务端返回的 `audio_url`。声音库中的产品标签是娱乐映射，不是动物情绪的科学定论。

## 5. 无效声音、失败和重试

### 无有效人声或宠物声

服务端可能先产生扣费意图，再通过幂等退款完成补偿。因此无效结果可能出现：

```json
{
  "state": "succeeded",
  "is_valid": false,
  "audio_url": null,
  "sound_id": null,
  "refund_status": "completed"
}
```

如果 `refund_status` 为 `pending`，同步 POST 返回 `503 PET_TRANSLATOR_PENDING` 和 `task_id`。客户端不自动查询或创建新任务；用户稍后手动重新提交时必须复用原 `X-Request-ID`，服务端会按幂等记录继续返回结果或待处理状态。最终净扣费为零。

### 同步提交、断线和查询

POST 会在服务端完成扣费、Gemini 分析、声音匹配和退款结算后返回，最长等待约 60 秒。App 可能在响应返回前断网、被杀进程或超时；这种情况下不会自动恢复结果。客户端应保留原录音和 `X-Request-ID`，让用户手动重新提交：

```text
使用同一个 X-Request-ID 再次 POST 同一段录音
不要生成新的请求 ID 来重放同一段录音
```

`GET /v1/pet-translator/tasks/{task_id}` 仅用于一次性查看任务或刷新人声转宠物的签名音频地址，不作为定时轮询接口。重复查询不消耗生成次数，也不会重复扣费。

如果返回 `409 IDEMPOTENCY_KEY_REUSED`，说明同一用户已经用这个请求 ID 提交了不同内容；放弃该 ID，重新录音并生成新的 UUID。不要用新 ID 重放同一录音来规避未知状态。

如果返回 `410 PET_TRANSLATOR_RESULT_EXPIRED`，任务文本和匹配记录已经清理，不能恢复播放；共享声音素材不会因此删除。

## 6. 音频播放和地址刷新

`audio_url` 是任务范围的签名地址，最长有效 15 分钟且不超过任务的 7 天保留期。它已经包含播放所需的签名 token，AVPlayer 直接使用该 URL 即可：

```swift
guard let audioURL = result.audioURL else { return }
let player = AVPlayer(url: audioURL)
player.play()
```

播放接口支持 `Range` 和 `HEAD`，不需要把音频完整下载到内存。播放地址过期或返回 401/404 时，先查询任务详情获取新的 `audio_url`，再替换 `AVPlayerItem`。如果任务已经过期，显示结果已过期并停止重试。

不要把 `audio_url` 分享给其他账号、写入跨账号缓存或永久保存。账户删除后，即使旧 URL 尚未到期，服务端也会禁止播放。

## 7. Swift 接入骨架

下面代码展示接口形状。建议把方法加到现有 `WorkerAPIClient` 内部，以复用其 401 refresh/bootstrap 重试、错误解析和 JSONDecoder。示例中的 multipart 字段名必须保持不变。

```swift
import Foundation

enum PetSpecies: String, Codable { case cat, dog }

struct PetTranslatorEnvelope<T: Decodable>: Decodable {
    let code: Int
    let message: String
    let data: T
}

struct PetTranslationData: Decodable {
    let taskID: String
    let direction: String
    let species: PetSpecies
    let language: String
    let state: String
    let phase: String
    let isValid: Bool?
    let emotion: String?
    let intent: String?
    let translation: String?
    let confidence: String?
    let explanation: String?
    let transcript: String?
    let meaning: String?
    let intensity: String?
    let audioURL: URL?
    let soundID: String?
    let soundEmotion: String?
    let soundIntensity: String?
    let audioDurationSeconds: Double?
    let soundLibraryVersion: String?
    let creditCost: Int
    let debitStatus: String
    let refundStatus: String
    let errorCode: String?
    let errorMessage: String?
    let createdAt: String
    let updatedAt: String
    let expiresAt: String
}
```

The existing custom snake_case decoder converts `task_id` to `taskID` and `audio_url` to `audioURL`. If another decoder is used, declare explicit `CodingKeys`.

Multipart construction can follow this pattern:

```swift
func makePetTranslationRequest(
    audio: Data,
    filename: String,
    mimeType: String,
    species: PetSpecies,
    requestID: UUID,
    directionPath: String,
    accessToken: String,
    appCheckToken: String?
) -> URLRequest {
    let boundary = "Boundary-\(UUID().uuidString)"
    var request = URLRequest(url: AppConfig.workerBaseURL.appendingPathComponent(directionPath))
    request.httpMethod = "POST"
    request.timeoutInterval = 70
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(requestID.uuidString.lowercased(), forHTTPHeaderField: "X-Request-ID")
    if let appCheckToken {
        request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")
    }

    request.httpBody = multipartBody(
        fields: ["species": species.rawValue, "language": "zh-CN"],
        fileField: "audio",
        filename: filename,
        mimeType: mimeType,
        data: audio,
        boundary: boundary
    )
    return request
}
```

`multipartBody` 应为每个文本字段追加 `Content-Disposition: form-data; name="..."`，文件字段追加 `name="audio"; filename="..."`、`Content-Type`、文件字节和最终 boundary。不要使用现有图片上传方法中固定的 `name="file"`。

如果 Worker 开启 App Check，上传前取得 Firebase token（FirebaseAppCheck 的具体 API 以当前 SDK 版本为准）：

```swift
let token = try await AppCheck.appCheck().token(forcingRefresh: false)
request.setValue(token.token, forHTTPHeaderField: "X-Firebase-AppCheck")
```

发送请求后，将响应解码为 `PetTranslatorEnvelope<PetTranslationData>`。只在 `state` 为终态且 `refund_status` 已确定时清除本地恢复状态。

## 8. 错误码和 UI 处理

错误响应统一为：

```json
{
  "error": {
    "code": "PET_TRANSLATOR_003",
    "message": "audio is too long"
  },
  "data": {
    "task_id": "task-uuid",
    "state": "failed"
  }
}
```

| HTTP / code | App 处理 |
| --- | --- |
| `401 UNAUTHORIZED` | refresh 一次，失败后 bootstrap，再用原请求 ID 重试 |
| `401 APP_CHECK_REQUIRED` | 刷新 App Check token 后重试 |
| `402 PET_TRANSLATOR_101` | 打开积分不足界面，不重复上传 |
| `409 PET_TRANSLATOR_BUSY` | 显示已有任务处理中，不自动轮询 |
| `409 IDEMPOTENCY_KEY_REUSED` | 丢弃该请求 ID，重新录音并生成新 UUID |
| `413 PET_TRANSLATOR_002` | 提示录音过大 |
| `415 PET_TRANSLATOR_004` | 提示文件格式或音轨无法解析 |
| `422 PET_TRANSLATOR_003` | 提示录音超过 15 秒 |
| `422 PET_TRANSLATOR_005/006/007/008` | 修正物种、语言、请求 ID 或表单字段 |
| `429 PET_TRANSLATOR_RATE_LIMITED` | 稍后重试；查询任务不受生成额度影响 |
| `503 PET_TRANSLATOR_NOT_CONFIGURED` | 显示服务暂不可用，不自动重试提交 |
| `503 PET_TRANSLATOR_PENDING` | 任务或退款尚未完成；保留原请求 ID，等待用户手动重新提交 |
| `503 PET_TRANSLATOR_SOUND_LIBRARY_NOT_READY` | 人→宠物素材库尚未开放，显示暂不可用 |
| `503 PET_TRANSLATOR_201/POINTS_PROVIDER_ERROR` | 服务或积分供应商失败；若响应带 `task_id` 则视为终态失败，重新录制 |
| `502 PET_TRANSLATOR_SOUND_UNAVAILABLE` | 无该情绪的审核素材；显示失败，可重新录音，退款由服务端处理 |
| `502 PET_TRANSLATOR_202` | 模型结果不可解析；显示失败，可重新录音，退款由服务端处理 |
| `502 PET_TRANSLATOR_500` | 翻译任务异常结束；显示失败，可重新录音 |
| `504 PET_TRANSLATOR_TIMEOUT` | 保留原请求 ID，等待用户手动重新提交 |
| `410 PET_TRANSLATOR_RESULT_EXPIRED` | 清理本地恢复状态，提示重新录音 |

录音内容只作为输入数据分析，不能把录音中的指令当成 App 指令。不要在日志中记录录音字节、完整转写或签名 URL。

## 9. 客户端验收清单

- 使用猫、狗和非法物种请求，验证物种不会跨库匹配。
- 验证 M4A/AAC、MP3、WAV、静音、噪音、损坏文件、超过 10 MiB 和超过 15 秒。
- 验证两方向都带 UUID `X-Request-ID`，相同录音重试不产生第二次扣费。
- 验证同一请求 ID 换录音返回 409，跨用户不能查询或播放任务。
- 验证人→宠物成功返回 `audio_url` 和声音元数据，且客户端不调用任何音效生成服务。
- 验证无有效人声、目标情绪没有可用素材时没有音频，积分最终退款。
- 验证 App 进入后台、断网、进程重启后不会自动查询；用户可用原 `X-Request-ID` 手动重新提交，播放失败时才单次刷新 `audio_url`。
- 验证 AVPlayer 的 Range 播放、签名地址刷新、地址过期和任务过期。
- Release 环境验证 App Check required；Debug 环境使用 Firebase App Check Debug provider。
