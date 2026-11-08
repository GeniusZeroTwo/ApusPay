#pragma execution_character_set("utf-8")

#include "MinHook.h"
#include "framework.h"
#include <condition_variable>
#include <mutex>
#include <queue>

#include "spy.h"
#include "log.h"
#include "receive_msg.h"
#include "util.h"

#include <stdlib.h>
#include "nlohmann/json.hpp"
#include "curl/curl.h"
#include <regex>
#pragma comment(lib, "libcurl.lib")

// Defined in spy.cpp
extern QWORD g_WeChatWinDllAddr;

// 接收消息call所在地址
#define OS_RECV_MSG_CALL    0x214C6C0

// 参数 消息ID 相对地址
#define OS_RECV_MSG_ID      0x30
// 参数 消息类型 相对地址
#define OS_RECV_MSG_TYPE    0x38
// 参数 是否自身 相对地址
#define OS_RECV_MSG_SELF    0x3C
// 参数 时间戳 相对地址
#define OS_RECV_MSG_TS      0x44
// 参数 房间ID 相对地址
#define OS_RECV_MSG_ROOMID  0x48
// 参数 消息内容 相对地址
#define OS_RECV_MSG_CONTENT 0x88
// 参数 wxid 相对地址
#define OS_RECV_MSG_WXID    0x240 // 0x80
// 参数 签名 相对地址
#define OS_RECV_MSG_SIGN    0x260 // 0xA0
// 参数 缩略图 相对地址
#define OS_RECV_MSG_THUMB   0x280 // 0xC0
// 参数 原图 相对地址
#define OS_RECV_MSG_EXTRA   0x2A0 // 0xE0
// 参数 XML 相对地址
#define OS_RECV_MSG_XML     0x308 // 0x148

typedef QWORD (*RecvMsg_t)(QWORD, QWORD);

static bool gIsListening = false;
static RecvMsg_t funcRecvMsg = nullptr;
static RecvMsg_t realRecvMsg = nullptr;
static bool isMH_Initialized = false;
static char baseUrl[MAX_PATH];

static string to_string(WxMsg_t wxMsg) {
    nlohmann::json j = {
            { "id", wxMsg.id },
            { "type", wxMsg.type },
            { "is_self", wxMsg.is_self },
            { "ts", wxMsg.ts },
            { "content", wxMsg.content },
            { "sign", wxMsg.sign },
            { "xml", wxMsg.xml },
            { "roomid", wxMsg.roomid },
            { "is_group", wxMsg.is_group },
            { "sender", wxMsg.sender },
            { "thumb", wxMsg.thumb },
            { "extra", wxMsg.extra }
    };
    return j.dump(4);
}

static void notice(string content)
{
    CURL* curl;
    CURLcode res;
    long res_code = 0;
    const char* postContent = content.c_str();
    const char* url = baseUrl;
    struct curl_slist* header = NULL;
    
    res = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (res != CURLE_OK)
    {
        LOG_INFO("curl_global_init() failed: {}", curl_easy_strerror(res));
        return;
    }
    curl = curl_easy_init();
    if (curl)
    {
        LOG_INFO("Send to backend {}: {}", url, postContent);

        curl_easy_setopt(curl, CURLOPT_URL, url);
        
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postContent);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)strlen(postContent));

        header = curl_slist_append(header, "Accept: */*");
        header = curl_slist_append(header, "Content-Type: application/json; charset=utf-8");
        header = curl_slist_append(header, "Connection: Close");
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, header);
        curl_easy_setopt(curl, CURLOPT_HEADER, 0L);

        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);

        curl_easy_setopt(curl, CURLOPT_USERAGENT, "curl/8.11.0");

        res = curl_easy_perform(curl);
        if (res != CURLE_OK)
        {
            LOG_INFO("curl_easy_perform() failed: {}", curl_easy_strerror(res));
        }
        else
        {
            res = curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &res_code);
            LOG_INFO("response {}", res_code);
        }
        curl_slist_free_all(header);
        curl_easy_cleanup(curl);
    }
    curl_global_cleanup();
}

static QWORD DispatchMsg(QWORD arg1, QWORD arg2)
{
    WxMsg_t wxMsg = { 0 };
    string str;
    try {
        wxMsg.id      = GET_QWORD(arg2 + OS_RECV_MSG_ID);
        wxMsg.type    = GET_DWORD(arg2 + OS_RECV_MSG_TYPE);
        wxMsg.is_self = GET_DWORD(arg2 + OS_RECV_MSG_SELF);
        wxMsg.ts      = GET_DWORD(arg2 + OS_RECV_MSG_TS);
        wxMsg.content = GetStringByWstrAddr(arg2 + OS_RECV_MSG_CONTENT);
        wxMsg.sign    = GetStringByWstrAddr(arg2 + OS_RECV_MSG_SIGN);
        wxMsg.xml     = GetStringByWstrAddr(arg2 + OS_RECV_MSG_XML);

        string roomid = GetStringByWstrAddr(arg2 + OS_RECV_MSG_ROOMID);
        wxMsg.roomid  = roomid;
        if (roomid.find("@chatroom") != string::npos) { // 群 ID 的格式为 xxxxxxxxxxx@chatroom
            wxMsg.is_group = true;
            if (wxMsg.is_self) {
                wxMsg.sender = "self";
            } else {
                wxMsg.sender = GetStringByWstrAddr(arg2 + OS_RECV_MSG_WXID);
            }
        } else {
            wxMsg.is_group = false;
            if (wxMsg.is_self) {
                wxMsg.sender = "self";
            } else {
                wxMsg.sender = roomid;
            }
        }
        wxMsg.thumb = GetStringByWstrAddr(arg2 + OS_RECV_MSG_THUMB);
        wxMsg.extra = GetStringByWstrAddr(arg2 + OS_RECV_MSG_EXTRA);

        if (wxMsg.type == 0x31)
        {
            // 微信收款助手 消息
            if (wxMsg.roomid == "gh_f0a92aa7146c")
            {
                std::string content = isGB2312(wxMsg.content)
                    ? GB2312ToUtf8(wxMsg.content.c_str())
                    : wxMsg.content;
                nlohmann::json to_log = {
                    { "content", content }
                };
                LOG_INFO(u8"Received specific message from gh_f0a92aa7146c (微信收款助手): {}", to_log.dump());
                if (content.find(u8"<appname><![CDATA[微信收款助手]]></appname>") != string::npos)
                {
                    // 同时满足 微信支付收款 和 店员消息 的格式
                    std::string pattern = u8"收款(到账)?(\\d+\\.\\d{2})元";
                    std::regex pat(pattern);
                    std::match_results<std::string::iterator> group;
                    if (std::regex_search(content.begin(), content.end(), group, pat) && group.size() > 1)
                    {
                        std::string money = group[2].str();
                        nlohmann::json j = {
                            { "type", "wechat" },
                            { "flags", "" },
                            { "money", money }
                        };
                        notice(j.dump(4));
                    }
                }
            }
            // 微信支付 消息
            if (wxMsg.roomid == "gh_3dfda90e39d6")
            {
                std::string content = isGB2312(wxMsg.content)
                    ? GB2312ToUtf8(wxMsg.content.c_str())
                    : wxMsg.content;
                nlohmann::json to_log = {
                    { "content", content }
                };
                LOG_INFO(u8"Received specific message from gh_3dfda90e39d6 (微信支付): {}", to_log.dump());
                if (content.find(u8"<appname><![CDATA[微信支付]]></appname>") != string::npos)
                {
                    std::string pattern = u8"二维码赞赏到账(\\d+\\.\\d{2})元";
                    std::regex pat(pattern);
                    std::match_results<std::string::iterator> group;
                    if (std::regex_search(content.begin(), content.end(), group, pat) && group.size() > 1)
                    {
                        std::string money = group[1].str();
                        nlohmann::json j = {
                            { "type", "wechat" },
                            { "flags", "reward-code" },
                            { "money", money }
                        };
                        notice(j.dump(4));
                    }
                }
            }
        }
    } catch (const std::exception &e) {
        LOG_ERROR(GB2312ToUtf8(e.what()).c_str());
    } catch (...) {
        LOG_ERROR("Unknow exception.");
    }

    return realRecvMsg(arg1, arg2);
}

static MH_STATUS InitializeHook()
{
    if (isMH_Initialized) {
        return MH_OK;
    }
    MH_STATUS status = MH_Initialize();
    if (status == MH_OK) {
        isMH_Initialized = true;
    }
    return status;
}

static MH_STATUS UninitializeHook()
{
    if (!isMH_Initialized) {
        return MH_OK;
    }
    if (gIsListening) {
        return MH_OK;
    }
    MH_STATUS status = MH_Uninitialize();
    if (status == MH_OK) {
        isMH_Initialized = false;
    }
    return status;
}

void ListenMessage(PortPath_t* pp)
{
    MH_STATUS status = MH_UNKNOWN;
    if (gIsListening) {
        LOG_WARN("gIsListening");
        return;
    }
    funcRecvMsg = (RecvMsg_t)(g_WeChatWinDllAddr + OS_RECV_MSG_CALL);

    status = InitializeHook();
    if (status != MH_OK) {
        LOG_ERROR("MH_Initialize failed: {}", to_string(status));
        return;
    }

    status = MH_CreateHook(funcRecvMsg, &DispatchMsg, reinterpret_cast<LPVOID *>(&realRecvMsg));
    if (status != MH_OK) {
        LOG_ERROR("MH_CreateHook failed: {}", to_string(status));
        return;
    }

    status = MH_EnableHook(funcRecvMsg);
    if (status != MH_OK) {
        LOG_ERROR("MH_EnableHook failed: {}", to_string(status));
        return;
    }

    gIsListening = true;
    strncpy_s(baseUrl, sizeof(baseUrl), pp->baseUrl, _TRUNCATE);
}

void UnListenMessage()
{
    MH_STATUS status = MH_UNKNOWN;
    if (!gIsListening) {
        return;
    }

    status = MH_DisableHook(funcRecvMsg);
    if (status != MH_OK) {
        LOG_ERROR("MH_DisableHook failed: {}", to_string(status));
        return;
    }

    gIsListening = false;

    status = UninitializeHook();
    if (status != MH_OK) {
        LOG_ERROR("MH_Uninitialize failed: {}", to_string(status));
        return;
    }
}
