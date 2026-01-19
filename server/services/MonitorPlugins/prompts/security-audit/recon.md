# 安全审计 - 信息收集阶段

## 阶段目标
收集目标系统的基本信息。

## 信息收集方法

### 被动收集
```bash
# WHOIS 查询
whois example.com

# DNS 查询
dig example.com
nslookup example.com

# 搜索引擎
site:example.com
```

### 主动收集
```bash
# 端口扫描
nmap -sV -sC target.com

# 服务识别
nmap -sV -p 80,443,22 target.com

# 目录枚举
gobuster dir -u http://target.com -w wordlist.txt
```

## 收集内容

| 类型 | 内容 |
|------|------|
| 网络 | IP、端口、服务 |
| 应用 | 技术栈、框架、版本 |
| 人员 | 邮箱、社交账号 |
| 组织 | 子域名、关联公司 |

## 工具推荐

- nmap - 端口扫描
- Shodan - 搜索引擎
- theHarvester - 信息收集
- Sublist3r - 子域名枚举

## 收集清单

- [ ] 是否收集了目标信息
- [ ] 是否枚举了开放端口
- [ ] 是否识别了服务版本
