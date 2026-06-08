// 像素小工程师精灵 + 调色板 + box-shadow 渲染（移植自 WhatRalph dashboard-p.html）
// 每行字符 = 一像素颜色码：h=头发 s=皮肤 e=眼 m=嘴 t=衣 p=裤 b=鞋 .=透明

export const SPRITES = {
  typing1: ["..hhhhhh..","hhhhhhhh.",".hsssssh.",".seesseeh.","..ssssss..","..ssmms...","...tttt...","..tttttt..",".stttttts.","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
  typing2: ["..hhhhhh..",".hhhhhhhh.","..ssssss..",".seesseeh.","..ssssss..","..ssmms...","...tttt...","..tttttt..","stttttttts","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
  idle: ["..hhhhhh..",".hhhhhhhh.","..ssssss..","..seesse..","..ssssss..","..ssmms...","...tttt...","..tttttt..",".stttttts.","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
  celebrate1: ["s..hhhh..s","s.hhhhhh.s","..ssssss..","..seesse..","..ssssss..","...smms...","s..tttt..s",".s.tttt.s.","..tttttt..","..tttttt..","...pppp...","...p..p...","..pp..pp..","..bb..bb.."],
  celebrate2: [".s.hhhh.s.","..hhhhhh..","..ssssss..","..seesse..","..ssssss..","...smms...",".s.tttt.s.","s..tttt..s","..tttttt..","..tttttt..","...pppp...","...p..p...","..pp..pp..","..bb..bb.."],
  sleeping: ["..........","..hhhhhh..",".hhhhhhhh.","..hhhhhh..","..ssssss..","..ssssss..","...tttt...","..tttttt..","..tttttt..","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
  frustrated: ["..hhhhhh..",".hhhhhhhh.","..ssssss..","..seesse..","..ssssss..","..ssssss..","s..tttt..s",".ssttttss.","..tttttt..","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
  walk1: ["..hhhhhh..",".hhhhhhhh.","..ssssss..","..seesse..","..ssssss..","..ssmms...","...tttt...","..tttttt..",".stttttts.","..tttttt..","...pppp...","..pp..p...","..p..pp...","..bb..bb.."],
  walk2: ["..hhhhhh..",".hhhhhhhh.","..ssssss..","..seesse..","..ssssss..","..ssmms...","...tttt...","..tttttt..",".stttttts.","..tttttt..","...pppp...","...p..pp..","...pp..p..","..bb..bb.."],
  coffee: ["..hhhhhh..",".hhhhhhhh.","..ssssss..","..seesse..","..ssssss..","..ssmms...","...tttt...","..tttttt..","..tttttts.","..tttttt..","...pppp...","...p..p...","...p..p...","...bb.bb.."],
};

export const PALETTES = [
  { h:"#2c3e50",s:"#f4c99b",e:"#1a1a2e",m:"#d4956b",t:"#e74c3c",p:"#34495e",b:"#1a1a2e" },
  { h:"#8b4513",s:"#e8b88a",e:"#1a1a2e",m:"#c08060",t:"#3498db",p:"#2c3e50",b:"#222" },
  { h:"#d4a017",s:"#c68c5c",e:"#1a1a2e",m:"#a06040",t:"#2ecc71",p:"#34495e",b:"#1a1a2e" },
  { h:"#c0392b",s:"#f0d0a0",e:"#1a1a2e",m:"#d0a080",t:"#f39c12",p:"#2c3e50",b:"#222" },
  { h:"#1a1a2e",s:"#a0704a",e:"#0d0d15",m:"#805030",t:"#9b59b6",p:"#34495e",b:"#111" },
  { h:"#654321",s:"#d4a574",e:"#1a1a2e",m:"#b08050",t:"#1abc9c",p:"#2c3e50",b:"#1a1a2e" },
  { h:"#f4a460",s:"#f4c99b",e:"#1a1a2e",m:"#d4956b",t:"#e67e22",p:"#34495e",b:"#222" },
  { h:"#2d1b00",s:"#c9956b",e:"#1a1a2e",m:"#a07050",t:"#34495e",p:"#2c3e50",b:"#111" },
  { h:"#4a4a4a",s:"#deb887",e:"#1a1a2e",m:"#be9870",t:"#e84393",p:"#34495e",b:"#1a1a2e" },
];

export const PIXEL_SCALE = 5;

// 把像素行数组转成单元素的多重 box-shadow（经典 CSS 像素画技巧）
export function spriteToBoxShadow(rows, palette) {
  const shadows = [];
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch !== '.' && palette[ch]) shadows.push(`${x}px ${y}px 0 0 ${palette[ch]}`);
    }
  return shadows.join(',');
}
