const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

// Configuration constants
const MAX_BATCH_SIZE = 500;
const DEFAULT_INTERESTS = ['adventure', 'discovery', 'friendship'];
const DEFAULT_PRONOUNS = {
  subjective: 'they',
  objective: 'them',
  possessive: 'their',
  reflexive: 'themselves'
};

exports.personalizeStoriesOnProfileChange = functions.firestore
  .document('children/{childId}')
  .onWrite(async (change, context) => {
    const childId = context.params.childId;
    const childData = change.after.exists ? change.after.data() : null;
    const previousData = change.before.exists ? change.before.data() : null;

    // Skip processing if non-personalization fields changed
    if (change.before.exists && change.after.exists) {
      const personalizationFields = ['name', 'pronouns', 'interests', 'culture', 'family'];
      const hasRelevantChange = personalizationFields.some(field => 
        JSON.stringify(childData[field]) !== JSON.stringify(previousData[field])
      );
      
      if (!hasRelevantChange) {
        functions.logger.log(`Skipping processing for ${childId}: No relevant changes detected`);
        return null;
      }
    }

    // Handle child deletion
    if (!childData) {
      await handleChildDeletion(childId);
      return null;
    }

    try {
      await generatePersonalizedStories(childId, childData);
      functions.logger.log(`Successfully processed stories for child: ${childId}`);
    } catch (error) {
      functions.logger.error(`Critical failure for child ${childId}:`, error);
    }

    return null;
  });

// Handle child deletion and story cleanup
async function handleChildDeletion(childId) {
  functions.logger.log(`Removing stories for deleted child: ${childId}`);
  let query = admin.firestore().collection('personalizedStories')
    .where('childId', '==', childId)
    .limit(MAX_BATCH_SIZE);

  while (true) {
    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = admin.firestore().batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    
    if (snapshot.size < MAX_BATCH_SIZE) break;
  }
}

// Main story generation logic
async function generatePersonalizedStories(childId, childData) {
  const childPersonalization = buildPersonalizationData(childData);
  const templates = await fetchActiveTemplates();

  if (templates.length === 0) {
    functions.logger.log('No active templates found');
    return;
  }

  const batches = [admin.firestore().batch()];
  let operationCount = 0;

  for (const template of templates) {
    const personalizedContent = personalizeTemplate(template, childPersonalization);
    
    const storyRef = admin.firestore().collection('personalizedStories')
      .doc(`${childId}-${template.id}`);
    
    const storyData = {
      childId,
      storyTemplateId: template.id,
      generatedContent: personalizedContent,
      title: template.title,
      coverImageUrl: template.coverImageUrl,
      generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      personalizationSnapshot: childPersonalization,
      status: 'ready'
    };

    // Batch management
    if (operationCount >= MAX_BATCH_SIZE) {
      batches.push(admin.firestore().batch());
      operationCount = 0;
    }
    
    batches[batches.length - 1].set(storyRef, storyData, { merge: true });
    operationCount++;
  }

  // Execute all batches
  await Promise.all(batches.map(batch => batch.commit()));
}

// Build consistent personalization structure
function buildPersonalizationData(childData) {
  return {
    name: childData.name || '[Unknown Child]',
    pronouns: childData.pronouns || DEFAULT_PRONOUNS,
    interests: childData.interests?.length ? [...childData.interests] : DEFAULT_INTERESTS,
    culture: childData.culture || {},
    family: childData.family || {}
  };
}

// Fetch active templates with error handling
async function fetchActiveTemplates() {
  try {
    const snapshot = await admin.firestore().collection('storyTemplates')
      .where('isActive', '==', true)
      .get();

    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    functions.logger.error('Template fetch failed:', error);
    return [];
  }
}

// Personalization engine with fallbacks
function personalizeTemplate(template, childData) {
  const replacements = {
    '\\[CHILD_NAME\\]': childData.name,
    '\\[PRONOUN_SUBJECTIVE\\]': childData.pronouns.subjective,
    '\\[PRONOUN_OBJECTIVE\\]': childData.pronouns.objective,
    '\\[PRONOUN_POSSESSIVE\\]': childData.pronouns.possessive,
    '\\[PRONOUN_REFLEXIVE\\]': childData.pronouns.reflexive,
    '\\[HOLIDAY\\]': childData.culture.holidays?.[0] || 'a special holiday',
    '\\[CULTURE_CUSTOM\\]': childData.culture.customs?.[0] || 'a local tradition',
    '\\[REGION\\]': childData.culture.region || 'their region',
    '\\[MOTHER_NAME\\]': childData.family.mother?.name || 'Mom',
    '\\[FATHER_NAME\\]': childData.family.father?.name || 'Dad',
    '\\[PET_NAME_1\\]': childData.family.pets?.[0] || 'Buddy',
    '\\[PET_NAME_2\\]': childData.family.pets?.[1] || 'Snowball'
  };

  let content = template.rawContent;

  // Standard replacements
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replace(new RegExp(key, 'g'), value);
  }

  // Special handling for interests
  for (let i = 1; i <= 3; i++) {
    const interest = childData.interests[i - 1] || childData.interests[0];
    content = content.replace(new RegExp(`\\[INTEREST_${i}\\]`, 'g'), interest);
  }

  return content;
}
