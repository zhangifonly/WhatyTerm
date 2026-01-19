# 文档处理 - 格式调整阶段

## 阶段目标
调整文档格式，确保一致性和美观。

## 格式要素

### 字体设置
```python
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

# 设置字体
run.font.name = 'Times New Roman'
run.font.size = Pt(12)
run.font.bold = True
```

### 段落设置
```python
from docx.shared import Inches

# 段落格式
paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
paragraph.paragraph_format.first_line_indent = Inches(0.5)
paragraph.paragraph_format.line_spacing = 1.5
```

### 页面设置
```python
from docx.shared import Inches

# 页边距
section = doc.sections[0]
section.top_margin = Inches(1)
section.bottom_margin = Inches(1)
section.left_margin = Inches(1.25)
section.right_margin = Inches(1.25)
```

## 常见格式

| 元素 | 格式 |
|------|------|
| 标题 | 加粗、大号 |
| 正文 | 12pt、1.5倍行距 |
| 页眉 | 居中、小号 |
| 页脚 | 页码居中 |

## 格式清单

- [ ] 格式是否统一
- [ ] 样式是否一致
- [ ] 排版是否美观
