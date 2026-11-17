# CowAgent provider capability matrix

Snapshot: `D:/Atry/cowagent-master-extracted/CowAgent-master` (read-only inspection). JSON is testable source of truth in the sibling file. Registration evidence is in `channel/channel_factory.py`; implementation `send()` evidence and README evidence are listed per row in JSON.

| Type | Source evidence | Source-level conclusion | Runtime / real delivery |
|---|---|---|---|
| terminal | factory:61; terminal_channel.py:206 | Local interactive UI; not outbound notification | Not run / not sent |
| web | factory:64; web/core/channel.py:167 | Local web UI; not outbound notification | Not run / not sent |
| wechatmp | factory:67; wechatmp_channel.py:168; README:3 | Passive reply, public callback/tunnel; not suitable for proactive notification | Not run / not sent |
| wechatmp_service | factory:70; wechatmp_channel.py:168; README:3 | Separate service-account implementation; proactive behavior not established | Not run / not sent |
| wechatcom_app | factory:73; wechatcomapp_channel.py:106; README:1 | Outbound method exists; callback/configuration and Windows packaging need validation | Not run / not sent |
| wechat_kf | factory:76; wechat_kf_channel.py:164; README:1 | Outbound method exists; public callback required by documented setup | Not run / not sent |
| feishu | factory:79; feishu_channel.py:979; README:1 | Outbound method exists; WebSocket mode avoids public callback, requires Internet | Not run / not sent |
| dingtalk | factory:82; dingtalk_channel.py:871 | Outbound method exists; transport details need validation | Not run / not sent |
| wecom_bot | factory:85; wecom_bot_channel.py:1092 | Outbound method exists; webhook semantics and Windows packaging need validation | Not run / not sent |
| qq | factory:88; qq_channel.py:634 | Outbound method and websocket close path exist | Not run / not sent |
| telegram | factory:91; telegram_channel.py:580,635,672 | Source-qualified active text candidate; the disposable Node adapter passed a controlled loopback protocol probe. The original Python SDK retry behavior is intentionally not reused. | Loopback protocol PASS; real delivery NOT RUN |
| slack | factory:94; slack_channel.py:448 | Outbound method exists; event transport and Windows runtime need validation | Not run / not sent |
| discord | factory:97; discord_channel.py:442 | Outbound method exists; gateway path not runtime checked | Not run / not sent |
| weixin | factory:100; weixin_channel.py:990 | Outbound method exists; transport/runtime not validated | Not run / not sent |

The matrix is deliberately conservative. A `send()` method or source-level receipt/message ID does not establish end-to-end delivery, idempotency, rate limits, Windows compatibility or revocation behavior. Unknown fields include an explicit reason in JSON. `telegram` is the only source-qualified candidate and its runtime status is limited to the controlled Windows Node loopback adapter probe; `v1OutboundCandidates` remains empty until a real provider adapter and separately authorized account test exist. No real account send was performed. The source matrix is not a production-readiness claim.

Candidate layers:

- `sourceQualifiedCandidates`: `telegram` only, based on inspected active-send/configuration source and the disposable adapter contract.
- `runtimeVerification`: loopback fake-provider protocol semantics only; this is not a provider or network delivery test.
- `realDeliveryVerification`: `not_run` for every provider because no real credentials or external send is authorized in the Spike.
