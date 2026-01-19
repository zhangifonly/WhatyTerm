# 文档处理 - 模板准备阶段

## 阶段目标
准备文档模板，定义变量和样式。

## 模板类型

### Word 模板
```python
from docx import Document

# 加载模板
doc = Document('template.docx')

# 替换变量
for paragraph in doc.paragraphs:
    if '{{name}}' in paragraph.text:
        paragraph.text = paragraph.text.replace('{{name}}', 'John')
```

### Excel 模板
```python
from openpyxl import load_workbook

wb = load_workbook('template.xlsx')
ws = wb.active

# 填充数据
ws['A1'] = 'Title'
ws['B2'] = 123
```

### LaTeX 模板
```latex
\documentclass{article}
\newcommand{\name}{John}
\newcommand{\date}{\today}

\begin{document}
Hello, \name!
\end{document}
```

## 变量定义

### 变量格式
```
{{variable_name}}
${variable_name}
%variable_name%
```

### 变量类型
| 类型 | 示例 |
|------|------|
| 文本 | {{name}} |
| 日期 | {{date}} |
| 数字 | {{amount}} |
| 列表 | {{items}} |

## 准备清单

- [ ] 模板是否完整
- [ ] 变量是否定义
- [ ] 格式是否正确
