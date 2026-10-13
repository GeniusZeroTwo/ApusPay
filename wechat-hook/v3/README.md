# SweetCheckout.Hook.WeChat

这个模块基于 [WeChatFerry](https://github.com/lich0821/WeChatFerry) 开发。

本模块仅适用于微信PC版 [3.9.12.51](https://github.com/tom-snow/wechat-windows-versions/releases/download/v3.9.12.51/WeChatSetup-3.9.12.51.exe)。

> **⚠️ 安全与架构建议提示**：
> 本模块采用了旧式的跨进程 DLL 注入（`CreateRemoteThread`）与内存 Hook 机制，易触发终端安全软件与客户端完整性告警。
> 建议改用零注入的 `v4` 模块，或直接采用 ApusPay 内置的**微信支付官方 Native / 服务商 APIv3** 模式。

## 自行构建

使用 Visual Studio 2022 打开解决方案 `Hook.sln` ，切换配置为 `Release`，点击 `生成`，`生成解决方案`，等待构建完成后，可在 `Out` 目录找到构建产物。

在该目录新建一个配置文件 `config.properties`，内容如下。
```properties
# Hook 终结点地址
api_url=http://127.0.0.1:62233/api/hook/receive

```

发布时，将以下文件一同打包发布

+ `SweetCheckout.Hook.WeChat.exe`
+ `config.properties`
+ `LICENSE`
