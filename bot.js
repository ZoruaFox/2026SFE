const { Mwn } = require('mwn');
const fs = require('fs');
const config = require('./config');
const utils = require('./utils');
const pc = require('picocolors');

async function getOAuth2Token() {
    // MediaWiki OAuth 2.0 Client Credentials Grant
    // Token endpoint usually: /w/rest.php/oauth2/access_token
    const tokenUrl = config.apiUrl.replace('api.php', 'rest.php/oauth2/access_token');
    
    console.log(pc.cyan(`[INFO] 获取 OAuth 2.0 令牌... (${tokenUrl})`));
    
    try {
        // Use global fetch (Node 18+)
        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': config.userAgent
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: config.oauth2.clientId,
                client_secret: config.oauth2.clientSecret
            })
        });

        if (!response.ok) {
            const body = await response.text();
            throw new Error(`OAuth2 Token fetch failed: ${response.status} ${body}`);
        }

        const data = await response.json();
        return data.access_token;
    } catch (e) {
        console.error(pc.red('[FATAL] 无法获取 OAuth 2.0 令牌'), e);
        process.exit(1);
    }
}

// 新增函数：查询用户的导入日志并计算导入得分
async function calculateImportScore(bot, username) {
    console.log(pc.dim(`[INFO] 开始计算用户 ${username} 的导入得分...`));
    
    const namespaces = [0, 6, 10, 206, 828];
    let importScore = 0;

    for (let i = 0; i < namespaces.length; i++) {
        const namespace = namespaces[i];
        const logQuery = {
            "action": "query",
            "format": "json",
            "list": "logevents",
            "formatversion": "2",
            "letype": "import",
            "lestart": "2026-01-31T16:00:00.000Z",
            "leend": "2026-02-07T03:45:54.000Z",
            "ledir": "newer",
            "leuser": username,
            "lenamespace": namespace,
            "lelimit": "max"
        };

        try {
            const result = await bot.request(logQuery);
            const logEvents = result.query.logevents || [];
            
            console.log(pc.blue(`[INFO] 用户 ${username} 在命名空间 ${namespace} 的导入日志数量: ${logEvents.length}`));
            
            if (namespace === 0) {
                importScore += logEvents.length * 0.02;
            } else {
                importScore += logEvents.length * 0.01;
            }
            
            // 在每次命名空间查询后添加小延时
            if (i < namespaces.length - 1) {
                await sleep(500); // 500ms的小延时
            }
            
        } catch (error) {
            console.error(pc.red(`[ERROR] 查询用户 ${username} 导入日志失败 (命名空间 ${namespace}):`), error);
        }
    }
    
    // 保留五位小数
    importScore = Math.round(importScore * 100000) / 100000;
    console.log(pc.green(`[INFO] 用户 ${username} 的导入得分为: ${importScore}`));
    
    return importScore;
}

/**
 * 处理单个用户的贡献页面
 */
async function processUserContribution(bot, page, username) {
    console.log(pc.dim(`[INFO] 正在处理用户: ${username}...`));

    try {
        // 读取页面内容
        const content = await bot.read(page.title);
        const wikitext = content.revisions[0].content;
        
        // 解析统计数据
        const parsedData = utils.parseContributionPageWithDetails(wikitext);
        let { entryCount, totalScore, items } = parsedData;
        
        // 检查是否存在导入日志行
        const importLogItem = findImportLogItem(items);
        let updatedItems = [...items];
        
        // 如果存在导入日志行，计算并更新导入得分
        if (importLogItem) {
            console.log(pc.yellow(`[INFO] 检测到用户 ${username} 的贡献页包含导入日志行，正在计算导入得分...`));
            const importScore = await calculateImportScore(bot, username);
            
            // 更新导入日志行的模板数据
            updatedItems = updateImportLogItem(updatedItems, importLogItem, importScore);
            
            // 重新计算总分（基于更新后的所有项目）
            totalScore = recalculateTotalScore(updatedItems);
        }
        
        // 格式化分数到小数点后两位
        const formattedScore = utils.formatScore(totalScore);
        
        // 更新用户页面内容
        const updateResult = await updateUserPage(bot, page.title, wikitext, entryCount, formattedScore, updatedItems);
        
        // 检查用户的资历状态
        const isVeteran = await checkVeteranStatus(bot, username);

        return {
            username,
            entryCount,
            totalScore: formattedScore,
            importScore: importLogItem ? parseFloat(importLogItem.score || 0) : 0,
            isVeteran,
            pageTitle: page.title,
            isUpdated: updateResult.isUpdated
        };

    } catch (err) {
        console.error(pc.red(`[ERROR] 处理页面 ${page.title} 时出错:`), err);
        return null;
    }
}

/**
 * 查找导入日志行项目
 */
function findImportLogItem(items) {
    return items.find(item => 
        item.originalLine.includes('type=import') && 
        (item.originalLine.includes('Special:日志') || item.originalLine.includes('Special:Log'))
    );
}

/**
 * 更新导入日志行项目
 */
function updateImportLogItem(items, importLogItem, importScore) {
    return items.map(item => {
        if (item.absolutePosition === importLogItem.absolutePosition) {
            return {
                ...item,
                score: importScore.toString(),
                status: '已审核', // 设置为已审核状态
                newScore: importScore.toString(),
                newStatus: '已审核'
            };
        }
        return item;
    });
}

/**
 * 重新计算总分
 */
function recalculateTotalScore(items) {
    return items.reduce((total, item) => {
        const score = parseFloat(item.score || item.newScore || 0);
        return isNaN(score) ? total : total + score;
    }, 0);
}

/**
 * 更新用户页面内容
 */
async function updateUserPage(bot, pageTitle, originalWikitext, entryCount, formattedScore, updatedItems) {
    let newContent = utils.updateUserPageContent(originalWikitext, entryCount, formattedScore);
    
    // 检查是否有需要更新的模板项
    const itemsToUpdate = updatedItems.filter(item => 
        item.newScore !== undefined || item.newStatus !== undefined
    );
    
    if (itemsToUpdate.length > 0) {
        newContent = utils.updatePageContentWithTemplates(newContent, itemsToUpdate);
    }
    
    let isUpdated = false;
    if (newContent !== originalWikitext) {
        isUpdated = true;
        const importScore = itemsToUpdate.find(item => item.newStatus === '已审核')?.newScore || 0;
        console.log(pc.yellow(`[ACTION] 更新页面 ${pageTitle}: 条目数=${entryCount}, 总得分=${formattedScore}, 导入得分=${importScore}`));
        await bot.save(pageTitle, newContent, `bot(2026SFE): 更新总得分和条目数${importScore > 0 ? `（含导入得分 ${importScore}）` : ''}`);
        // 礼貌延时
        await sleep(config.apiDelayMs); 
    } else {
        console.log(pc.gray(`[INFO] ${pageTitle} 的页面数据无需更新。`));
    }
    
    return { isUpdated, newContent };
}

/**
 * 检查用户是否为"熟练编者"
 * 定义：在 2026-02-01 之前已完成 50 次编辑
 */
async function checkVeteranStatus(bot, username) {
    console.log(pc.dim(`[INFO] 检查用户 ${username} 的资历状态...`));
    
    try {
        // API 查询：list=usercontribs
        const contribs = await bot.request({
            action: 'query',
            list: 'usercontribs',
            ucuser: username,
            ucstart: '2026-02-01T00:00:00Z',
            uclimit: 55,
            ucdir: 'older'
        });
        
        // 添加小延时
        await sleep(300);
        
        const isVeteran = contribs.query.usercontribs.length >= 50;
        console.log(pc.dim(`[INFO] 用户 ${username} ${isVeteran ? '是' : '不是'} 熟练编者`));
        return isVeteran;
        
    } catch (err) {
        console.error(pc.yellow(`[WARN] 无法检查用户 ${username} 的资历状态:`), err);
        return false;
    }
}

async function updateLeaderboard(bot, participants) {
    const leaderboardTitle = 'Qiuwen:2026年春节编辑松/提交'; 
    console.log(pc.cyan(`[INFO] 正在更新总排行榜: ${leaderboardTitle}...`));

    try {
        let content = await bot.read(leaderboardTitle).then(res => res.revisions[0].content);

        // 分类排序：
        // 1. 熟练编者 / 新星编者
        // 2. 排序优先级：总分 (降序) -> 条目数 (降序)
        const sortFn = (a, b) => b.totalScore - a.totalScore || b.entryCount - a.entryCount;
        
        const veterans = participants.filter(p => p.isVeteran).sort(sortFn);
        const newStars = participants.filter(p => !p.isVeteran).sort(sortFn);
        const allParticipants = [...participants].sort(sortFn);

        // 生成表格行的辅助函数
        const generateRows = (list, markNewStar = false) => {
            if (list.length === 0) return '|- \n| colspan="5" style="text-align: center;" | 暂无数据\n';
            return list.map((p, index) => {
                let userDisplay = `[[User:${p.username}|${p.username}]]`;
                if (markNewStar && !p.isVeteran) {
                    // 使用显眼的样式标记新星编者
                    userDisplay = `🌱 ${userDisplay}`;
                }

                // 生成一行：| 排名 || 贡献者 || 已提交条数 || 目前得分 || 贡献详情页
                return `|- 
| ${index + 1} || ${userDisplay} || ${p.entryCount} || ${p.totalScore} || [[${p.pageTitle}|查看页面]]`;
            }).join('\n');
        };

        const veteranRows = generateRows(veterans);
        const newStarRows = generateRows(newStars);
        const allRows = generateRows(allParticipants, true);

        // 更新时间戳
        content = updateTimestamp(content);

        // 替换页面中的表格内容
        // 注意：这种正则/字符串替换策略依赖于页面结构保持稳定（{{FakeH3|...}} 标题存在）
        content = replaceTableContent(content, '编者总榜', allRows);
        content = replaceTableContent(content, '熟练编者排行榜', veteranRows);
        content = replaceTableContent(content, '新星编者排行榜', newStarRows);

        // 写入更新后的排行榜
        await bot.save(leaderboardTitle, content, 'bot(2026SFE): 更新排行榜');
        console.log(pc.green('[SUCCESS] 总排行榜已更新。'));

    } catch (err) {
        console.error(pc.red('[ERROR] 更新总排行榜失败:'), err);
    }
}

/**
 * 更新页面中的时间戳
 * 在"（以下排行约每小时更新一次）"之后添加最近更新时间
 */
function updateTimestamp(content) {
    // 获取当前时间并转换为 UTC+8（中国标准时间）
    const now = new Date();
    
    // 正确计算 UTC+8 时间：
    // 直接在 UTC 时间戳基础上增加 8 小时
    const utc8Ms = now.getTime() + (8 * 60 * 60 * 1000);
    const utc8Time = new Date(utc8Ms);
    
    // 格式化时间：xxxx年xx月xx日 xx:xx:xx UTC+8
    const year = utc8Time.getUTCFullYear();
    const month = String(utc8Time.getUTCMonth() + 1).padStart(2, '0');
    const day = String(utc8Time.getUTCDate()).padStart(2, '0');
    const hours = String(utc8Time.getUTCHours()).padStart(2, '0');
    const minutes = String(utc8Time.getUTCMinutes()).padStart(2, '0');
    const seconds = String(utc8Time.getUTCSeconds()).padStart(2, '0');
    
    const timestamp = `${year}年${month}月${day}日 ${hours}:${minutes}:${seconds} UTC+8`;
    const timestampLine = `{{center|（最近更新：${timestamp}）}}`;
    
    // 查找"（以下排行约每小时更新一次）"的位置
    const targetText = '{{center|（以下排行约每小时更新一次）}}';
    const targetIndex = content.indexOf(targetText);
    
    if (targetIndex === -1) {
        console.log(pc.yellow('[WARN] 未找到更新提示文本，跳过时间戳更新'));
        return content;
    }
    
    // 查找目标文本之后的下一行
    const afterTarget = targetIndex + targetText.length;
    const nextLineStart = content.indexOf('\n', afterTarget) + 1;
    
    // 检查是否已存在时间戳行
    // 时间戳搜索范围：在目标文本后的前100个字符内查找
    // 这个范围足够覆盖紧跟目标文本的时间戳行，同时避免误匹配页面其他位置的时间戳
    const TIMESTAMP_SEARCH_RANGE = 100;
    const existingTimestampPattern = /\{\{center\|（最近更新：.*?\）\}\}/;
    const contentAfterTarget = content.substring(nextLineStart);
    const timestampMatch = contentAfterTarget.match(existingTimestampPattern);
    
    if (timestampMatch && contentAfterTarget.indexOf(timestampMatch[0]) < TIMESTAMP_SEARCH_RANGE) {
        // 如果已存在时间戳（在目标文本后100个字符内），则替换它
        const oldTimestampIndex = nextLineStart + contentAfterTarget.indexOf(timestampMatch[0]);
        const oldTimestampEnd = oldTimestampIndex + timestampMatch[0].length;
        return content.substring(0, oldTimestampIndex) + timestampLine + content.substring(oldTimestampEnd);
    } else {
        // 如果不存在，则插入新的时间戳行
        return content.substring(0, nextLineStart) + timestampLine + '\n' + content.substring(nextLineStart);
    }
}

function replaceTableContent(fullText, sectionName, newRows) {
    // 1. Find section
    const sectionIndex = fullText.indexOf(sectionName);
    if (sectionIndex === -1) return fullText;

    // 2. Find start of table after section
    const tableStartIndex = fullText.indexOf('{|', sectionIndex);
    if (tableStartIndex === -1) return fullText;

    // 3. Find end of table
    // We need to match nested tables if any? 
    // Assuming simple structure as per sample.
    const tableEndIndex = fullText.indexOf('|}', tableStartIndex);
    if (tableEndIndex === -1) return fullText;

    // 4. Find the header seperator `|-`? 
    // The sample shows:
    // {| ...
    // ! headers
    // |-
    // | content
    // |}
    // We want to keep headers. The headers usually end with the first `|-` that is NOT followed by `|` or `!` immediately on same line?
    // Actually the standard is `|-` starts a new row.
    // Let's assume the first `|-` after `{|` defines the separation between table decl/headers and body IF headers are used with `!`.
    // BUT the sample:
    // {| class="sf-table"
    // ! style="..." | 排名
    // ...
    // ! style="..." | 贡献详情页
    // |-     <-- Split point
    // | ...
    // |}
    
    const tableContent = fullText.substring(tableStartIndex, tableEndIndex);
    // Find the last header row ending.
    // Usually headers are `! ...`
    // We can assume the *first* `|-` that comes after the last `!` line? 
    // Or just find the first `|-` after the `! ...` block.
    
    // Let's use a standard anchor logic:
    // Look for the header line `! style="width: 20%; text-align:center" | 贡献详情页`
    // The `|-` after that is where we inject.
    
    const headerAnchor = '贡献详情页';
    const headerLoc = tableContent.indexOf(headerAnchor);
    if (headerLoc === -1) return fullText; // Safety
    
    const splitPoint = tableContent.indexOf('|-', headerLoc);
    if (splitPoint === -1) return fullText;
    
    // Construct new table
    const tableHead = tableContent.substring(0, splitPoint);
    const newTable = `${tableHead}${newRows}\n`; // existing part includes start of table up to first |- (exclusive? no |- is start of row)
    
    // Wait, `splitPoint` is index of `|-`.
    // If I take 0 to splitPoint, I get headers.
    // Then I add `newRows` (which should start with `|-`).
    // Then close with `|}`.
    
    // Let's verify `newRows` format in `generateRows`: it starts with `|-`.
    // So yes.
    
    const preTable = fullText.substring(0, tableStartIndex);
    const postTable = fullText.substring(tableEndIndex);
    
    return `${preTable}${tableHead}${newRows}\n${postTable}`;
}

function generateGithubSummary(participants) {
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;

    const totalParticipants = participants.length;
    const updatedCount = participants.filter(p => p.isUpdated).length;
    const totalEntries = participants.reduce((sum, p) => sum + p.entryCount, 0);
    const totalScore = participants.reduce((sum, p) => sum + p.totalScore, 0);

    const headers = ['用户', '条目数', '得分', '资历', '状态'];
    const rows = participants.sort((a,b) => b.totalScore - a.totalScore).map(p => [
        p.username,
        p.entryCount,
        p.totalScore,
        p.isVeteran ? '✅' : '🆕',
        p.isUpdated ? '📝 已更新' : '无变化'
    ]);

    let markdown = `## 2026年春节编辑松机器人运行摘要 🚀\n\n`;
    markdown += `- **参与总人数**: ${totalParticipants}\n`;
    markdown += `- **本次更新页面数**: ${updatedCount}\n`;
    markdown += `- **总条目数**: ${totalEntries}\n`;
    markdown += `- **总得分**: ${totalScore}\n\n`;

    markdown += `### 参与者详情\n\n`;
    markdown += `| ${headers.join(' | ')} |\n`;
    markdown += `| ${headers.map(() => '---').join(' | ')} |\n`;
    
    rows.forEach(row => {
        markdown += `| ${row.join(' | ')} |\n`;
    });
    
    markdown += `\n摘要生成于 ${new Date().toISOString()}`;

    try {
        fs.appendFileSync(summaryFile, markdown);
    } catch (error) {
        console.error('Error writing to GITHUB_STEP_SUMMARY:', error);
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)); // 礼貌延时

/**
 * 封装主逻辑，增加错误处理，确保脚本退出状态正确
 */
async function main() {
    console.log(pc.cyan('[INFO] 开始执行2026年春节编辑松统计机器人...'));
    
    // 1. 获取 OAuth 2.0 Token
    const accessToken = config.oauth2.accessToken || await getOAuth2Token();

    // 2. 初始化 bot 实例
    const bot = new Mwn({
        apiUrl: config.apiUrl,
        userAgent: config.userAgent,
        defaultParams: {
            assert: 'user',
            maxlag: 5 
        }
    });

    const originalRequest = bot.request;
    bot.request = async function(params) {
        // 确保headers中的Authorization值只包含ASCII字符
        if(this.requestOptions.headers && this.requestOptions.headers.Authorization) {
            const authHeader = this.requestOptions.headers.Authorization;
            const cleanAuthHeader = authHeader.split('').filter(char => 
                char.charCodeAt(0) <= 255
            ).join('');
            this.requestOptions.headers.Authorization = cleanAuthHeader;
        }
        return originalRequest.call(this, params);
    };

    // 3. 注入 Header
    bot.requestOptions.headers = {
        ...bot.requestOptions.headers,
        'Authorization': `Bearer ${accessToken}`
    };

    try {
        // 4. 验证登录状态并获取编辑令牌
        console.log(pc.blue('[INFO] 验证登录状态并获取编辑令牌...'));
        await bot.getTokens();
        
        const user = await bot.userinfo();
        console.log(pc.green(`[INFO] 登录成功，当前身份: ${user.name}`));
        
        // 在初始化后添加延时
        console.log(pc.dim('[WAIT] API初始化完成，等待片刻...'));
        await sleep(config.apiDelayMs);

    } catch (e) {
        console.error(pc.red('[FATAL] 初始化失败或认证无效:'), e);
        process.exit(1);
    }

    // 5. 查找所有的贡献页面
    const prefix = 'Qiuwen:2026年春节编辑松/提交/';
    console.log(pc.blue('[INFO] 正在获取所有贡献页面列表...'));
    
    const pages = await bot.request({
        action: 'query',
        list: 'allpages',
        apprefix: '2026年春节编辑松/提交/',
        apnamespace: 4,
        aplimit: 'max',
        apfilterredir: 'nonredirects'
    }).then(data => data.query.allpages);

    console.log(pc.green(`[INFO] 找到 ${pages.length} 个页面，其中 ${pages.filter(p => p.title.endsWith('的贡献')).length} 个贡献页面`));
    
    // 在获取页面列表后添加延时
    await sleep(config.apiDelayMs / 2);

    // 6. 处理所有用户的贡献页面
    const contributionPages = pages.filter(page => page.title.endsWith('的贡献'));
    console.log(pc.blue(`[INFO] 开始处理 ${contributionPages.length} 个用户的贡献页面...`));
    
    const processingResults = [];
    
    for (let i = 0; i < contributionPages.length; i++) {
        const page = contributionPages[i];
        const username = page.title.replace(prefix, '').replace('的贡献', '');
        
        console.log(pc.dim(`[${i + 1}/${contributionPages.length}] 正在处理用户: ${username}...`));
        
        try {
            const result = await processUserContribution(bot, page, username);
            if (result) {
                processingResults.push(result);
            }
            
            // 在每次用户处理完成后添加延时
            if (i < contributionPages.length - 1) { // 不是最后一个用户时才延时
                console.log(pc.dim(`[WAIT] 用户 ${username} 处理完成，等待 ${config.apiDelayMs}ms...`));
                await sleep(config.apiDelayMs);
            }
            
        } catch (err) {
            console.error(pc.red(`[ERROR] 处理用户 ${username} 时发生严重错误:`), err);
            // 即使出错也继续处理下一个用户
        }
    }

    const successfulParticipants = processingResults.filter(result => result !== null);
    console.log(pc.green(`[SUCCESS] 用户处理完成！成功处理 ${successfulParticipants.length}/${contributionPages.length} 个用户。`));

    // 7. 更新总排行榜
    if (successfulParticipants.length > 0) {
        console.log(pc.blue('[INFO] 开始更新总排行榜...'));
        await sleep(config.apiDelayMs); // 排行榜更新前的延时
        await updateLeaderboard(bot, successfulParticipants);
        console.log(pc.green('[SUCCESS] 总排行榜更新完成！'));
    } else {
        console.log(pc.yellow('[WARN] 没有成功处理的用户，跳过排行榜更新。'));
    }

    // 8. 输出最终统计信息
    const totalProcessed = successfulParticipants.length;
    const updatedCount = successfulParticipants.filter(p => p.isUpdated).length;
    const totalEntries = successfulParticipants.reduce((sum, p) => sum + p.entryCount, 0);
    const totalScore = successfulParticipants.reduce((sum, p) => sum + p.totalScore, 0);
    const totalImportScore = successfulParticipants.reduce((sum, p) => sum + p.importScore, 0);
    
    console.log(pc.cyan('\n=== 最终统计报告 ==='));
    console.log(pc.green(`✓ 成功处理用户数: ${totalProcessed}`));
    console.log(pc.yellow(`✓ 页面更新数量: ${updatedCount}`));
    console.log(pc.blue(`✓ 总条目数: ${totalEntries}`));
    console.log(pc.magenta(`✓ 总得分: ${totalScore.toFixed(2)}`));
    console.log(pc.cyan(`✓ 导入总得分: ${totalImportScore.toFixed(5)}`));
    console.log(pc.cyan('====================\n'));
    
    console.log(pc.green('[SUCCESS] 2026年春节编辑松统计机器人执行完毕！'));
}

main().catch(console.error); // 捕获主函数未处理的异常
