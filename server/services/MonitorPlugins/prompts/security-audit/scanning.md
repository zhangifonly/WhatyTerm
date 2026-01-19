# 安全审计 - 漏洞扫描阶段

## 阶段目标
使用工具扫描潜在漏洞。

## 扫描工具

### Web 漏洞扫描
```bash
# Nikto
nikto -h http://target.com

# OWASP ZAP
zap-cli quick-scan http://target.com

# Nuclei
nuclei -u http://target.com
```

### SQL 注入扫描
```bash
# SQLMap
sqlmap -u "http://target.com/page?id=1" --dbs
```

### 漏洞扫描器
- Nessus
- OpenVAS
- Qualys

## 常见漏洞类型

| 漏洞 | 说明 | 风险 |
|------|------|------|
| SQL 注入 | 数据库查询注入 | 高 |
| XSS | 跨站脚本 | 中-高 |
| CSRF | 跨站请求伪造 | 中 |
| 文件包含 | 本地/远程文件包含 | 高 |
| 命令注入 | 系统命令执行 | 高 |

## 扫描结果分析

### 风险等级
- Critical: 立即修复
- High: 尽快修复
- Medium: 计划修复
- Low: 评估后处理
- Info: 仅供参考

## 扫描清单

- [ ] 是否完成漏洞扫描
- [ ] 是否分析了扫描结果
- [ ] 是否标记了高危漏洞
