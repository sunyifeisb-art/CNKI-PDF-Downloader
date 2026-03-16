# CNKI论文PDF批量下载助手

<p align="center">
  <img src="./assets/readme-hero.svg?v=20260316-1" alt="CNKI论文PDF批量下载助手预览" width="100%" />
</p>

<p align="center">
  面向 <strong>Chrome / Edge Manifest V3</strong> 的知网侧边栏扩展。<br>
  把检索结果页中的论文整理成可批量处理的 PDF 下载队列。
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome%20Extension-MV3-3b82f6?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Chrome%20%2F%20Edge-64748b?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-0f766e?style=flat-square">
  <img alt="Status" src="https://img.shields.io/badge/Status-Open%20Source-1d4ed8?style=flat-square">
</p>

> 说明：下载前提是你的账号、机构或 WebVPN 本身具备对应文献的知网下载权限。本插件只提供快捷抓取、整理与下载触发能力，不绕过任何权限控制。

## 下载与安装

当前项目以源码形式开源，暂未上架 Chrome 应用商店，因此安装时需要开启浏览器扩展管理页的开发者模式。

### 方式一：直接下载源码安装

1. 打开本仓库页面。
2. 点击右上角 `Code` -> `Download ZIP`。
3. 解压 ZIP 文件到本地任意目录。
4. 打开 Chrome 或 Edge 的扩展管理页。
5. 开启右上角“开发者模式”。
6. 点击“加载已解压的扩展程序”。
7. 选择刚刚解压后的项目目录。

### 方式二：Git 克隆安装

```bash
git clone https://github.com/sunyifeisb-art/CNKI-PDF-Downloader.git
```

克隆后同样需要：

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择克隆下来的项目目录。

## 这个插件能做什么

- 把当前知网检索结果页论文一键加入队列
- 自动抓取详情页中的 PDF 下载入口
- 批量下载 PDF
- 补全期刊等级并显示为醒目的徽章
- 支持 WebVPN 场景
- 支持按时间、被引、下载排序
- 支持摘要展开、关键词查看、文献信息复制
- 提供紧凑错误日志，方便排查登录、验证、CAJ-only 等问题

## 使用流程

<p>
  <img src="./assets/readme-flow.svg?v=20260316-1" alt="使用流程说明图" width="100%" />
</p>

1. 打开知网检索结果页。
2. 打开扩展侧边栏。
3. 点击“抓取本页”，把当前结果页论文加入队列并抓取 PDF 链接。
4. 查看期刊等级、关键词、摘要和下载状态。
5. 点击“批量下载”。
6. 如果失败，查看底部错误日志，通常会明确告诉你是登录、验证、只有 CAJ，还是没有 PDF 权限。

## WebVPN 是做什么的

如果你是通过学校或机构的 WebVPN 访问知网，请打开扩展中的 `WebVPN` 开关；如果你本来就在知网直连环境中，通常不需要打开。

## 本地加载

1. 打开 Chrome 或 Edge 的扩展管理页。
2. 开启开发者模式。
3. 选择“加载已解压的扩展程序”。
4. 选择本项目目录。

## 目录结构

```text
.
├── manifest.json
├── background.js
├── content/
│   └── main.js
├── sidepanel/
│   ├── index.html
│   ├── index.css
│   └── index.js
├── icons/
└── assets/
```

## 适用场景

- 知网检索后需要连续下载一批 PDF
- 想先筛核心期刊、再决定下载顺序
- 在学校 / 机构 / WebVPN 环境下批量整理论文
- 想把“点详情页、点 PDF、返回列表”这种重复动作压缩掉

## 许可证

MIT
