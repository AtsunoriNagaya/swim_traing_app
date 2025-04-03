import { Redis } from '@upstash/redis';
import { saveJsonToBlob, getJsonFromBlob } from './blob-storage';

// Redis クライアントの初期化 (Vercel KV または Upstash Redis を想定)
let redis: Redis;
try {
  // Vercel KV またはカスタム名の環境変数を優先
  const redisUrl = process.env.KV_REST_API_URL || process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    throw new Error("Missing Redis environment variables");
  }

  redis = new Redis({
    url: redisUrl,
    token: redisToken,
  });
  console.log(`[Redis] ✅ Redis クライアント初期化成功`);
} catch (error) {
  console.error("[Redis] 🚨 Redis 初期化エラー:", error);
  // フォールバック: インメモリのスタブを使用
  redis = {
    get: async () => null,
    set: async () => "OK",
  } as unknown as Redis;
}

// メニュー項目の型定義
interface MenuItem {
  description: string;
  distance: string;
  sets: number;
  circle: string;
  rest: string | number;
  equipment?: string;
  notes?: string;
  time?: number;
}

// メニューセクションの型定義
interface MenuSection {
  name: string;
  items: MenuItem[];
  totalTime?: number;
}

// メニューデータの型定義
interface GeneratedMenuData {
  title: string;
  menu: MenuSection[];
  totalTime: number;
  intensity?: string | null;
  targetSkills?: string[] | null;
}

// スコアリングされたメニューの型定義
interface ScoredMenu {
  menuData: GeneratedMenuData;
  similarityScore: number;
}

const INDEX_FILE_NAME = 'menus/index.json';

/**
 * メニューデータをVercel Blobに保存する
 */
export async function saveMenu(menuId: string, menuData: any) {
  // メニューデータをBlobに保存し、正確なURLを取得
  const menuDataUrl = await saveJsonToBlob(menuData, `menus/${menuId}.json`);
  console.log(`[KV] Saved menu data to Blob, URL: ${menuDataUrl}`);

  // インデックスファイルを取得
  const indexData = await getIndexData();

  // メタデータを生成
  const metadata = {
    loadLevels: menuData.loadLevels ? menuData.loadLevels.join(',') : "",
    duration: menuData.duration ? menuData.duration.toString() : "0",
    notes: menuData.notes || "",
    createdAt: new Date().toISOString(),
    totalTime: menuData.totalTime ? menuData.totalTime.toString() : "0",
    intensity: menuData.intensity || "",
    targetSkills: menuData.targetSkills || [],
    title: menuData.title || "Untitled",
    aiModel: menuData.aiModel || "Unknown",
  };

  // インデックスファイルにメニューを追加
  indexData.menus.push({
    id: menuId,
    metadata: metadata,
    menuDataUrl: menuDataUrl
  });

  // インデックスファイルをBlobに保存
  const indexFileUrl = await saveJsonToBlob(indexData, INDEX_FILE_NAME);

  // RedisにインデックスファイルのURLを保存
  await redis.set('menu:indexUrl', indexFileUrl);
}

/**
 * メニューの類似度を計算する
 */
export async function searchSimilarMenus(query: string, duration: number): Promise<ScoredMenu[]> {
  const indexData = await getIndexData();
  const results: ScoredMenu[] = [];
  
  // クエリから負荷レベルを抽出
  const queryLevels = query.split(' ').filter(q => ['A', 'B', 'C'].includes(q));
  
  // クエリからキーワードを抽出（負荷レベルと時間を除外）
  const keywords = query.toLowerCase()
    .split(' ')
    .filter(word => 
      !['A', 'B', 'C'].includes(word) && 
      !word.endsWith('分') &&
      word.length > 1
    );

  for (const menu of indexData.menus) {
    try {
      let score = 0;
      const metadata = menu.metadata;
      
      // 時間範囲での類似度（現在の±20%）
      const menuDuration = parseInt(metadata.duration);
      if (menuDuration >= duration * 0.8 && menuDuration <= duration * 1.2) {
        score += 3;
        // より近い時間により高いスコア
        const durationDiff = Math.abs(duration - menuDuration);
        if (durationDiff <= 5) score += 2;
        else if (durationDiff <= 10) score += 1;
      } else {
        continue; // 時間が大きく異なる場合はスキップ
      }
      
      // 負荷レベルの一致度
      const menuLevels = metadata.loadLevels.split(',');
      const levelMatch = menuLevels.filter((l: string) => queryLevels.includes(l)).length;
      score += levelMatch * 2;
      
      // キーワードマッチング
      const menuText = [
        metadata.title,
        metadata.notes,
        ...(metadata.targetSkills || [])
      ].join(' ').toLowerCase();
      
      for (const keyword of keywords) {
        if (menuText.includes(keyword)) {
          score += 1;
        }
      }
      
      // メニューデータを取得
      const menuData = await handleBlobError(() => getJsonFromBlob(menu.menuDataUrl)) as GeneratedMenuData | null;
      if (menuData) {
        // メニュー構成の類似度
        const sectionNames = menuData.menu.map(s => s.name.toLowerCase());
        const hasWarmup = sectionNames.some(name => name.includes('w-up'));
        const hasMain = sectionNames.some(name => name.includes('main'));
        const hasCooldown = sectionNames.some(name => name.includes('down'));
        
        if (hasWarmup) score += 1;
        if (hasMain) score += 1;
        if (hasCooldown) score += 1;
        
        // スコアが一定以上のメニューのみを結果に追加
        if (score >= 3) {
          results.push({
            menuData,
            similarityScore: score
          });
        }
      }
    } catch (error) {
      console.error(`メニュー検索エラー (ID: ${menu.id}):`, error);
      continue;
    }
  }
  
  // スコアの高い順にソート
  return results
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, 5); // 上位5件のみを返す
}

/**
 * インデックスファイルの取得処理を共通化
 */
async function getIndexData() {
  try {
    console.log("[KV] 🔍 Getting index URL from Redis store");
    const indexFileUrl = await redis.get<string>('menu:indexUrl');
    
    if (!indexFileUrl) {
      console.warn("[KV] ⚠️ Index file URL not found in KV store");
      return { menus: [] };
    }
    
    console.log("[KV] ✅ Retrieved index URL from KV:", indexFileUrl?.substring(0, 50) + "...");

    console.log("[KV] 🔍 Fetching index data from Blob storage");
    const indexData = await handleBlobError(() => getJsonFromBlob(indexFileUrl)) as { menus: any[] } | null;
    
    if (!indexData) {
      console.warn("[KV] ⚠️ Failed to retrieve index data from Blob");
      return { menus: [] };
    }
    
    const menuCount = indexData.menus?.length || 0;
    console.log(`[KV] ✅ Retrieved index data from Blob with ${menuCount} menus`);
    
    return indexData || { menus: [] };
  } catch (error: any) {
    console.error("[KV] Error fetching index data:", {
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    return { menus: [] };
  }
}

/**
 * エラーハンドリングを共通化
 */
async function handleBlobError<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    console.error('Blob storage error:', error);
    return null;
  }
}

/**
 * 指定されたIDのメニューデータを取得する
 */
export async function getMenu(menuId: string): Promise<GeneratedMenuData | null> {
  try {
    console.log(`[KV] 🔍 Searching for menu with ID: ${menuId}`);
    
    // インデックスファイルからメニューデータのURLを取得
    const indexData = await getIndexData();
    
    if (!indexData.menus || indexData.menus.length === 0) {
      console.warn(`[KV] ⚠️ Index contains no menus, cannot find menu ID: ${menuId}`);
      return null;
    }
    
    // 部分一致や関連IDも探す
    const menuEntry = indexData.menus.find(menu => 
      menu.id === menuId || menu.id.includes(menuId) || menuId.includes(menu.id)
    );

    // メニューが見つからない場合
    if (!menuEntry) {
      console.warn(`[KV] ⚠️ Menu ID ${menuId} not found in index`);
      return null;
    }
    
    if (!menuEntry.menuDataUrl) {
      console.warn(`[KV] ⚠️ Menu entry found but menuDataUrl is missing for ID: ${menuEntry.id}`);
      return null;
    }

    console.log(`[KV] ✅ Found menu ${menuEntry.id} in index, menuDataUrl: ${menuEntry.menuDataUrl}`);

    // Blobからメニューデータを取得
    console.log(`[KV] 🔍 Fetching menu data from Blob storage using indexed URL: ${menuEntry.menuDataUrl}`);
    const menuData = await handleBlobError(() => getJsonFromBlob(menuEntry.menuDataUrl)) as GeneratedMenuData | null;
    
    if (!menuData) {
      console.error(`[KV] 🚨 Menu data not found in Blob storage using URL from index: ${menuEntry.menuDataUrl}`);
      return null;
    }
    
    console.log(`[KV] ✅ Successfully retrieved menu data from Blob storage for ID: ${menuEntry.id}`);
    return menuData;
  } catch (error: any) {
    console.error(`[KV] Error fetching menu ${menuId}:`, {
      error: error.message,
      stack: error.stack,
      name: error.name
    });
    return null;
  }
}

/**
 * すべてのメニュー履歴を取得する
 */
export async function getMenuHistory(): Promise<{
  id: string;
  loadLevels: string[];
  duration: number;
  notes: string;
  createdAt: string;
  totalTime: number;
  intensity: string;
  targetSkills: string[];
  title: string;
  aiModel: string;
}[]> {
  try {
    // インデックスファイルを取得
    const indexData = await getIndexData();

    const menus = indexData.menus.map((menu) => {
      // メタデータの型変換を行う
      const metadata = menu.metadata;
      return {
        id: menu.id,
        ...metadata,
        // loadLevelsを文字列から配列に変換
        loadLevels: metadata.loadLevels ? metadata.loadLevels.split(',').filter(Boolean) : [],
        // 数値型の項目を変換
        duration: parseInt(metadata.duration) || 0,
        totalTime: parseInt(metadata.totalTime) || 0,
        // 配列型の項目を確実に配列として扱う
        targetSkills: Array.isArray(metadata.targetSkills) ? metadata.targetSkills : [],
      };
    });

    // 作成日時の降順でソート（新しい順）
    return menus.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  } catch (error) {
    console.error("[KV] メニュー履歴の取得に失敗:", error);
    return [];
  }
}
