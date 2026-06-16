// public/creditManager.js

// Unified subscription plans & limits
window.PLAN_LIMITS = {
  free: {
    name: "Free",
    monthlyWallet: 25000,
    rollingWindowLimit: 2500,
    rateLimits: { RPM: 10, RPH: 100 },
    concurrentAgents: 1,
    builderProjects: 3
  },
  pro: {
    name: "Pro",
    monthlyWallet: 500000,
    rollingWindowLimit: 50000,
    rateLimits: { RPM: 60, RPH: 1000 },
    concurrentAgents: 5,
    builderProjects: 25
  },
  max: {
    name: "Max",
    monthlyWallet: 3000000,
    rollingWindowLimit: 200000,
    rateLimits: { RPM: 200, RPH: 5000 },
    concurrentAgents: 20,
    builderProjects: Infinity
  },
  enterprise: {
    name: "Enterprise",
    monthlyWallet: Infinity,
    rollingWindowLimit: Infinity,
    rateLimits: { RPM: Infinity, RPH: Infinity },
    concurrentAgents: Infinity,
    builderProjects: Infinity
  }
};

// MIMO Cost Configuration
window.MIMO_COST_CONFIG = {
  'mimo-v2.5': { inCacheHit: 2, miss: 100, output: 200 },
  'mimo-v2.5-pro': { inCacheHit: 2.5, miss: 300, output: 600 }
};

// A helper function to dynamically calculate rolling window usage from usageEvents collection
window.calculateRollingUsage = async function(db, uid) {
  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  try {
    const snap = await db.collection('users').doc(uid).collection('usageEvents')
      .where('timestamp', '>=', firebase.firestore.Timestamp.fromDate(fiveHoursAgo))
      .get();
    
    let total = 0;
    snap.forEach(doc => {
      total += doc.data().credits || 0;
    });
    return total;
  } catch (err) {
    console.error("Error calculating rolling usage:", err);
    return 0;
  }
};

// Get current system load capacity scaling
window.getSystemLoadScaling = async function(db) {
  try {
    const doc = await db.collection('system').doc('config').get();
    if (doc.exists) {
      const data = doc.data();
      const load = data.systemLoad || 'low'; // low, medium, high, critical
      const scaling = { low: 1.0, medium: 0.8, high: 0.6, critical: 0.4 };
      return scaling[load] || 1.0;
    }
  } catch (err) {
    console.error("Error fetching system load scaling:", err);
  }
  return 1.0;
};

// Deduct credits and log usage event
window.deductCredits = async function(db, uid, amount, product, model, requestType) {
  if (!db || !uid) return { success: false, error: "Database or user UID not provided." };
  
  const userRef = db.collection('users').doc(uid);
  
  try {
    // Run a transaction to verify limits and deduct credits atomically
    const result = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      if (!userDoc.exists) {
        throw new Error("User does not exist.");
      }
      
      const userData = userDoc.data();
      const plan = userData.plan || 'free';
      const planLimits = window.PLAN_LIMITS[plan] || window.PLAN_LIMITS.free;
      
      // Check if system config has emergency disabled flags
      const configRef = db.collection('system').doc('config');
      const configDoc = await transaction.get(configRef);
      let systemLoad = 'low';
      if (configDoc.exists) {
        const configData = configDoc.data();
        if (configData.maintenanceMode) throw new Error("System is currently undergoing maintenance.");
        if (configData.disableBuilder && product === 'builder') throw new Error("Builder module is currently disabled.");
        if (configData.disableAgentFleet && product === 'fleet') throw new Error("Agent Fleet module is currently disabled.");
        if (configData.disableFreeUsers && plan === 'free') throw new Error("Free tier access is temporarily suspended due to high system load.");
        systemLoad = configData.systemLoad || 'low';
      }
      
      // Calculate monthly wallet limit
      const monthlyWallet = userData.monthlyWallet !== undefined ? userData.monthlyWallet : planLimits.monthlyWallet;
      const monthlyUsed = userData.monthlyUsed || 0;
      const newMonthlyUsed = monthlyUsed + amount;
      
      if (plan !== 'enterprise' && newMonthlyUsed > monthlyWallet) {
        throw new Error("Insufficient monthly wallet balance. You need " + amount + " credits, but only have " + Math.max(0, monthlyWallet - monthlyUsed) + " left.");
      }
      
      // Compute 5-hour rolling usage inside transaction
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      const eventsSnap = await db.collection('users').doc(uid).collection('usageEvents')
        .where('timestamp', '>=', firebase.firestore.Timestamp.fromDate(fiveHoursAgo))
        .get();
      
      let rollingWindowUsed = 0;
      eventsSnap.forEach(d => {
        rollingWindowUsed += d.data().credits || 0;
      });
      
      const loadScaling = { low: 1.0, medium: 0.8, high: 0.6, critical: 0.4 }[systemLoad] || 1.0;
      const allowedRollingLimit = planLimits.rollingWindowLimit * loadScaling;
      
      if (plan !== 'enterprise' && (rollingWindowUsed + amount) > allowedRollingLimit) {
        throw new Error("Rolling 5-hour compute window limit exceeded (" + Math.floor(rollingWindowUsed) + " used, " + allowedRollingLimit + " allowed under " + systemLoad + " system load). Please wait for usage slots to expire.");
      }
      
      // Check Rate Limits
      const oneMinAgo = new Date(Date.now() - 60000);
      const oneHourAgo = new Date(Date.now() - 3600000);
      
      const rpmSnap = await db.collection('users').doc(uid).collection('usageEvents')
        .where('timestamp', '>=', firebase.firestore.Timestamp.fromDate(oneMinAgo))
        .get();
      const rphSnap = await db.collection('users').doc(uid).collection('usageEvents')
        .where('timestamp', '>=', firebase.firestore.Timestamp.fromDate(oneHourAgo))
        .get();
      
      if (plan !== 'enterprise') {
        if (rpmSnap.size >= planLimits.rateLimits.RPM) {
          throw new Error("Rate limit exceeded: Only " + planLimits.rateLimits.RPM + " requests/minute are allowed on your plan.");
        }
        if (rphSnap.size >= planLimits.rateLimits.RPH) {
          throw new Error("Rate limit exceeded: Only " + planLimits.rateLimits.RPH + " requests/hour are allowed on your plan.");
        }
      }
      
      // Update User stats
      const productUsageField = product === 'chat' ? 'chatUsage' : (product === 'builder' ? 'builderUsage' : 'agentUsage');
      const updatePayload = {
        monthlyUsed: newMonthlyUsed,
        [productUsageField]: (userData[productUsageField] || 0) + amount,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      
      transaction.update(userRef, updatePayload);
      
      // Create detailed usage event document
      const eventRef = db.collection('users').doc(uid).collection('usageEvents').doc();
      const eventPayload = {
        product: product,
        model: model || 'mimo-v2.5',
        credits: amount,
        requestType: requestType || 'request',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      };
      transaction.set(eventRef, eventPayload);
      
      return { success: true, newMonthlyUsed };
    });
    
    return result;
  } catch (err) {
    console.error("Deduction transaction failed:", err);
    return { success: false, error: err.message };
  }
};

// Check and perform auto-migration for a logged-in user
window.performAutoMigration = async function(db, uid) {
  if (!db || !uid) return;
  const userRef = db.collection('users').doc(uid);
  try {
    const doc = await userRef.get();
    if (doc.exists) {
      const data = doc.data();
      // If user does not have new unified wallet stats, migrate them
      if (data.monthlyWallet === undefined) {
        const plan = data.plan || 'free';
        const planLimits = window.PLAN_LIMITS[plan] || window.PLAN_LIMITS.free;
        
        // Wipe legacy quotas, map plan to unified values
        const updatePayload = {
          monthlyWallet: planLimits.monthlyWallet,
          monthlyUsed: 0,
          chatUsage: 0,
          builderUsage: 0,
          agentUsage: 0,
          createdAt: data.createdAt || firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        // Delete all old builderTokens, chat remaining/used credits, and fleet variables if they exist
        const deleteFields = {};
        if (data.builderTokens !== undefined) deleteFields.builderTokens = firebase.firestore.FieldValue.delete();
        if (data.remainingCredits !== undefined) deleteFields.remainingCredits = firebase.firestore.FieldValue.delete();
        if (data.usedCredits !== undefined) deleteFields.usedCredits = firebase.firestore.FieldValue.delete();
        if (data.monthlyCredits !== undefined) deleteFields.monthlyCredits = firebase.firestore.FieldValue.delete();
        if (data.windowTokens !== undefined) deleteFields.windowTokens = firebase.firestore.FieldValue.delete();
        
        await userRef.set(updatePayload, { merge: true });
        if (Object.keys(deleteFields).length > 0) {
          await userRef.update(deleteFields);
        }
        console.log(`Successfully migrated user ${uid} to Unified Wallet V2.`);
      }
    }
  } catch (err) {
    console.error("Failed to perform auto-migration:", err);
  }
};
