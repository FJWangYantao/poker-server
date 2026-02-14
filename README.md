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

服务器运行在 http://localhost:3001

---

## 前端配置

部署后端后，需要更新前端配置：

1. 打开 `/workspace/poker-game`
2. 创建或编辑 `.env` 文件：
   ```
   VITE_SERVER_URL=https://你的Render地址
   ```
3. 重新构建并部署前端

---

## 技术支持

- Render 免费套餐：750小时/月，足够朋友间使用
- 服务器会在15分钟无活动后进入休眠，下次访问会自动唤醒
