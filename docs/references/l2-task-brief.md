# Reference: L2 命题任务原文 — 从零实现一个 TUI 终端编码 Agent（发布版）

> 状态：reference（命题原文存档，只读不改） · 归档：2026-06-27
> 来源：《L2命题任务-从零实现一个 TUI 终端编码 Agent（发布版）.docx》。
> 这是本项目的**需求权威来源**。规格如何落地见 [`docs/product-specs/index.md`](../product-specs/index.md)。

---

## 一、题目说明

请从零实现一个最小可用的 TUI 终端编码 Agent。

这里的 TUI 指 Terminal User Interface，即运行在终端中的图形化交互界面。程序应在终端内提供结构化的输入、输出、状态展示和交互确认能力。

用户在终端交互界面中通过自然语言下达开发任务。Agent 需要结合当前代码仓库上下文理解任务意图，自主规划执行步骤，完成必要的工具调用，并在工具结果基础上继续推理，直到任务完成、失败终止或给出明确回复。

本题对应 Claude Code、Cursor Agent、Codex CLI、Gemini CLI 等终端 AI 编程工具的最小核心形态，重点考察候选人对 **Agent Loop、工具系统、权限控制、LLM Provider 接入、会话上下文、配置管理和 TUI 交互体验** 的工程实现能力。

## 二、功能要求

候选人需要提交一个可运行的本地程序。程序必须以 TUI 形式呈现。界面应展示用户输入、模型回复、工具调用过程、工具执行结果、权限确认信息和当前运行状态，使用户能够了解 Agent 当前正在执行的任务和所处阶段。

Agent 需要实现完整的 **模型决策—工具调用—结果回传—继续推理** 流程。对于需要仓库上下文或执行结果的任务，Agent 应主动读取文件、搜索代码、执行必要命令，并根据工具结果继续判断后续动作。

Agent 需要具备基础代码仓库操作能力，包括 **目录浏览、文件读取、文件匹配、内容搜索、文件写入或编辑，以及 Shell 命令执行**。工具应以结构化方式暴露给模型使用，并具备清晰的输入、输出和错误返回机制。

Agent 必须具备基础权限控制。**只读类操作可以自动执行；文件写入、文件编辑和 Shell 命令执行必须经过用户确认。** 用户拒绝授权时，对应操作不得执行，拒绝结果应进入会话上下文。

Agent 需要支持接入 **WPS CodingPlan 协议**。程序具备工具调用解析、流式输出、超时控制和基础重试等能力。
（参考：Coding Plan 平台使用手册 — 见 [`coding-plan-platform.md`](coding-plan-platform.md)）

## 三、会话、配置与内置命令

程序需要支持多轮会话上下文管理。用户输入、模型回复、工具调用、工具执行结果、权限拒绝结果和错误信息都应进入会话历史。

程序需要支持用户级配置和项目级配置，并满足 **项目级配置优先于用户级配置**。配置内容应覆盖 Provider、模型、API 地址、超时时间、最大循环轮次等基础信息。**API Key 等敏感信息不得暴露。**

TUI 中应提供基础内置命令，用于查看帮助、清空当前会话、查看或切换当前模型、查看运行状态和退出程序。

## 四、实现约束

候选人可以使用第三方库接入 OpenAI、Anthropic 等模型协议，也可以使用第三方库完成 TUI 渲染、HTTP 请求、配置解析、日志记录和测试等非核心能力。

候选人**不得使用第三方 Agent SDK 或 Agent Framework** 直接实现 Agent Loop、工具系统、权限控制或会话管理等核心能力。上述核心逻辑应由候选人自行设计和实现。

候选人可参考开源项目获取灵感，但不得以已有项目为基底修改后提交（含 Fork、Clone 改动、整体复制重命名等）。模块职责相似属领域共性，不视为问题；评审关注实现细节与接口设计是否体现自主决策，并结合 AI 协作记录评估设计主导能力。

需自行处理和 Agent 的关键对话内容沉淀，存储在项目 `.ai_history/logs/` 目录下即可。

## 五、扩展方向

候选人可以在基础能力稳定的前提下进行功能扩展，扩展功能会适当加分，扩展功能的方向可以是如支持优异的上下文压缩实现等等。

扩展能力不应替代或弱化基础功能要求。

## 六、交付要求说明

遵循 L2 认证考核维度要求指导。

**交付清单：**
- 项目源码仓库：可编译运行的 TUI Agent 完整源码等
- AI 协作过程记录：`.ai_history/logs/` 目录（第四节要求，必须提交至源码仓库）
- 可运行的验证产物：放置在源码目录 `deliverables/` 下，详见第 2 点阐述

**产物基本说明：**
- 交付的 Coding Agent 应能够在真实环境中运行，并能完成一定复杂度的开发任务，例如读取项目文件、搜索代码、修改文件、执行测试命令，并根据工具返回结果继续完成任务。
- 项目测试范围应至少覆盖 **Agent 主循环、工具调用与结果回传、权限确认与拒绝、配置优先级和 Mock LLM Provider 场景**。
- 可运行的验证产物交付说明：自行用 Code Agent 完成一个小任务证明 Agent 可运行即可，如贪吃蛇小游戏，提供相关的关键运行截图统一放置在目录 `deliverables/` 即可。

## 七、参考项目

> 可参考产品形态、交互方式和架构思路，提交结果应体现独立设计和实现。

| 项目 | 地址 | 参考重点 |
|---|---|---|
| OpenCode | https://github.com/sst/opencode | 多 Provider、TUI、工具调用和权限控制 |
| OpenAI Codex CLI | https://github.com/openai/codex | Agent Loop、工具执行、代码读写和命令运行 |
| Google Gemini CLI | https://github.com/google-gemini/gemini-cli | 项目上下文、工具系统和模型配置 |
| Pi / Pi Coding Agent | https://github.com/earendil-works/pi | 最小 Agent 内核、工具调用、会话机制、可扩展架构 |
| Aider | https://github.com/Aider-AI/aider | Git Diff、代码编辑、仓库级上下文管理 |
| Goose | https://github.com/block/goose | 本地任务自动化、工具扩展、多模型适配 |
| Awesome CLI Coding Agents | https://github.com/bradAGI/awesome-cli-coding-agents | CLI Coding Agent 生态索引 |
