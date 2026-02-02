# 2026年春节编辑松联络员审核工具

这是一个（半）自动化机器人，用于统计参与者在 2026 年春节编辑松中的贡献，并自动更新排行榜。

## 功能

1.  **自动统计**：扫描用户贡献页，统计通过的条目数及积分。
2.  **更新提示板**：更新用户个人贡献页顶部的 `{{mbox}}` 状态。
3.  **排行榜管理**：自动区分“熟练编者”与“新星编者”，并更新总排行榜。

## 运行环境

*   Node.js 18+
*   MediaWiki OAuth 2.0 权限

## 安装与配置

1.  安装依赖：
    ```bash
    pnpm install
    ```

2.  配置环境变量：
    复制 `.env.example` 为 `.env` 并填写配置：
    ```bash
    cp .env.example .env
    ```
    *   `OAUTH2_CLIENT_ID`: OAuth 2.0 客户端 ID
    *   `OAUTH2_CLIENT_SECRET`: OAuth 2.0 客户端密钥

## 运行

### 本地运行
#### 更新排行榜和总得分
```bash
node bot.js
```
#### 获取待审核列表
```bash
node get_pending_list.js
```
#### 审核工具
先运行：
```bash
node review.js
```
生成pending_data.json后，打开[review.html](./review.html)并上传。在html下载后导出updated_pages.json。

再运行：
```bash
node review.js --update-pages
```
之后会自动保存修改。


## 许可协议

本项目采用 [MIT License](LICENSE) 开源许可协议。

## 声明

本仓库代码包含 GitHub Copilot、通义灵码 生成内容。
