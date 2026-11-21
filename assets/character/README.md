# 已确认的日系可爱角色

当前唯一视觉基线是用户于 2026-11-21 明确确认的概念稿：白皙肤色、蜂蜜棕大眼睛、栗色双辫、褪色蓝灰破布裙、毛边与粗针缝补、旧袜和磨损皮鞋。后续开发应沿用这位人物的脸与画风。

## 原画保真

`kawaii-approved.webp` 来自批准概念稿原图的无损格式转换，完整保留 1536 × 1024 RGB 像素。转换时逐字节比较解码后的 RGB，确认一致。原始 PNG 的 SHA-256 为：

`2417a2c3f47a922a64f84ce207d112c016a1f4c9bf7ca9b0152470ff514fed7a`

原图左边是完整人物，右边是两个表情特写。运行时通过 SVG 视口和裁切路径显示左侧人物，不重新生成人物、不改动原图像素、不拉伸比例。默认装扮只绘制一次完整原图，不切开头部和服装。白色人物舞台保持原画肤色和底色。

## 完整换装组合

所有素材仍使用原图 1536 × 1024 坐标，保持人物位置和姿势。三套裙装 × 三种发型以及基础旧衣的三种发型共 12 张画稿，直接选择整幅组合，避免头发压在衣领上的区域出现拼接或旧发辫残留。

| 服装 | 栗色双辫（默认） | 波波头 | 双马尾 |
| --- | --- | --- | --- |
| 旧布补丁裙 | `kawaii-approved.webp` | `kawaii-hair-bob.webp` | `kawaii-hair-twintails.webp` |
| 蓝色公主裙 | `kawaii-dress-sky.webp` | `kawaii-dress-sky-bob.webp` | `kawaii-dress-sky-twintails.webp` |
| 蜜桃花边裙 | `kawaii-dress-peach.webp` | `kawaii-dress-peach-bob.webp` | `kawaii-dress-peach-twintails.webp` |
| 紫藤花裙 | `kawaii-dress-lilac.webp` | `kawaii-dress-lilac-bob.webp` | `kawaii-dress-lilac-twintails.webp` |

变体使用内置 image_gen，以批准概念稿或已生成的对应裙装为编辑底图，并在需要时以新发型画稿作为发型参考。编辑约束为：保持面容、画风、肤色、全画幅、人物大小和位置、站姿、手脚以及右侧特写，只改变所选服装或发型。生成不保证逐像素锁定，因此变体在游戏中继续覆盖批准原画的面容区域，妆容只在玩家选择后叠加。

## 运行与维护

三种解锁鞋使用与原画一致的插画素材 `kawaii-shoes-rose.webp`、`kawaii-shoes-maryjane.webp`、`kawaii-shoes-crystal.webp`。运行时仅替换原生坐标 y880–1024 的鞋袜区域，默认旧鞋仍是批准原画本身。

`girlIllustration()` 保留全部十个换装槽位、白名单输入和无障碍描述，首页、衣橱、结算共用该函数。存档 ID、解锁条件和喂食流程不变。衣服和发型预览使用同一套画稿，发饰、鞋子和首饰按这位新人物的坐标佩戴。

静态构建发布十二张人物组合与三张鞋履 WebP。修改资产名时同步更新构建清单。发布前核对原画与默认人物、全部 12 种衣服/发型组合、十槽位搭配及手机布局。
