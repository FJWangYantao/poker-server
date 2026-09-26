---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3045022100c2af6ffba689d9cf7ed0dbc3a62b43c1eb7ef11cf9592d706a7dac044854b7d802206e3bfa0d9bc847019f1759fac8a133f60bda22b17e7b48ce0e69ad0f7dd49c6f
    ReservedCode2: 3045022100b342d686dde5219c89afae1d3f647850397dfcec9f1813bc7934fb2cf5e25d6e022018569d8bff84ebe0c120b6f5cd25f629153fea14e124074874118a82576eeeb9
---

# 德州扑克多人联机服务器

## 快速部署到 Render（免费）

### 步骤 1: 将代码上传到 GitHub

1. 登录 [GitHub](https://github.com)
2. 创建一个新仓库，命名为 `poker-server`
3. 将 `/workspace/poker-server` 文件夹内容上传到仓库

### 步骤 2: 部署到 Render

1. 登录 [Render](https://render.com)
2. 点击 "New +" → 选择 "Web Service"
3. 连接到您的 GitHub 仓库
4. 配置如下：
   - **Name**: poker-server
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. 点击 "Create Web Service"

### 步骤 3: 获取服务器地址

部署完成后，Render 会提供一个 URL，格式类似：
```
https://poker-server-xxxx.onrender.com
```

**请将这个地址复制下来，后面会用到！**

---

## 本地运行

```bash
cd poker-server
npm install
npm start
```

打开 http://localhost:3001 即可游玩（前端页面由服务器直接提供，无需单独部署）。

运行测试：

```bash
npm test
```

---

## 玩法说明

- 创建房间后点击房间号即可复制邀请链接，好友打开链接输入昵称就能加入
- 游戏进行中也可以加入，会从下一局开始参与
- 刷新页面或网络短暂断开会自动回到原座位
- 每次行动限时 30 秒，超时自动过牌（无法过牌则弃牌）；掉线玩家限时 15 秒
- 掉线或连续两次超时的玩家会被设为"暂离"，下一局不再发牌，点"回到座位"即可恢复
- 每局结束后 8 秒自动开始下一局，房主也可以点击"立即开始下一局"
- 筹码输光后可以补充筹码继续玩
- 支持主池/边池结算、平分底池

可通过环境变量调整时间（单位：秒）：`TURN_SECONDS`、`DISCONNECTED_TURN_SECONDS`、`NEXT_HAND_SECONDS`。

---

## 技术支持

- Render 免费套餐：750小时/月，足够朋友间使用
- 服务器会在15分钟无活动后进入休眠，下次访问会自动唤醒
- 房间数据保存在内存中，服务器重启或休眠后房间会清空
