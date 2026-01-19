# 文档处理 - 导出发布阶段

## 阶段目标
导出最终文档，验证输出质量。

## 导出格式

### 常见格式
| 格式 | 用途 | 工具 |
|------|------|------|
| PDF | 打印、分发 | Word、LaTeX |
| DOCX | 编辑、协作 | Word、LibreOffice |
| HTML | 网页展示 | Pandoc |
| EPUB | 电子书 | Calibre |

### 导出命令
```bash
# Pandoc 转换
pandoc input.md -o output.pdf
pandoc input.md -o output.docx

# LaTeX 编译
pdflatex document.tex
xelatex document.tex  # 支持中文
```

## 质量检查

### 文件检查
- 文件大小是否正常
- 页数是否正确
- 图片是否清晰
- 字体是否嵌入

### 内容检查
- 目录是否正确
- 页码是否连续
- 链接是否有效
- 格式是否一致

## 发布流程

```
1. 导出文档
2. 质量检查
3. 备份原文件
4. 发布/分发
```

## 导出清单

- [ ] 导出是否成功
- [ ] 文件是否完整
- [ ] 格式是否正确
