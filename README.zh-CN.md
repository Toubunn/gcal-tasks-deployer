<div align="right">
  <a href="README.md">English</a> | <a href="README.ja.md">日本語</a> | <strong>简体中文</strong>
</div>

# gcal-tasks-deployer

一款专为高效日程管理设计的浏览器插件。通过智能读取屏幕截图并利用 AI 进行内容分析，帮助您一键将文本、图片中的日程信息快速同步至谷歌日历（Google Calendar）和待办事项（Google Tasks）。

### 功能特点
- **截图智能识别**：直接读取并分析截图中的时间、事件等关键信息。
- **一键快速部署**：无需手动输入，自动生成并快速添加日程。
- **多模型支持**：支持配置 **Gemini**、**OpenAI** 以及 **DeepSeek** 的 API。

### 安装方法
1. 下载本项目的所有代码文件至本地。
2. 打开 Chrome 浏览器，输入 `chrome://extensions/`。
3. 打开右上角的 **“开发者模式”** 开关。
4. 将下载的文件夹直接拖拽到该页面中即可。

### 注意事项（配置说明）
- 本插件不自带任何 API 密钥。
- **使用前需要您自行填入**：相应 AI 平台的 API Key，以及 Google 凭据（`Google Client ID` 和 `Google Client Secret`）。
- **隐私安全**：所有配置的敏感数据仅保存在您本地浏览器的安全存储中，绝不进行外部上传。
