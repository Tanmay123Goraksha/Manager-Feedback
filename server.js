// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// In-memory storage (use database in production)
let feedback = [];
let feedbackIdCounter = 1;

// Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// AI Rate limiting (more restrictive)
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 AI requests per minute
    message: 'Too many AI requests, please try again later.'
});

// Validation middleware
const validateFeedback = [
    body('title').trim().isLength({ min: 1, max: 200 }).withMessage('Title must be 1-200 characters'),
    body('description').trim().isLength({ min: 1, max: 2000 }).withMessage('Description must be 1-2000 characters'),
    body('type').isIn(['bug', 'feature', 'improvement', 'other']).withMessage('Invalid feedback type'),
    body('priority').isIn(['low', 'medium', 'high']).withMessage('Invalid priority level'),
    body('email').isEmail().withMessage('Valid email is required'),
];

const validateAIQuery = [
    body('question').trim().isLength({ min: 1, max: 500 }).withMessage('Question must be 1-500 characters'),
];

// Error handling middleware
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            success: false,
            errors: errors.array()
        });
    }
    next();
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'FeedbackAI API is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Get all feedback with filtering and pagination
app.get('/api/feedback', (req, res) => {
    try {
        const { status, type, priority, page = 1, limit = 10, sort = 'createdAt', order = 'desc' } = req.query;
        
        let filteredFeedback = [...feedback];
        
        // Apply filters
        if (status && status !== 'all') {
            filteredFeedback = filteredFeedback.filter(item => item.status === status);
        }
        if (type && type !== 'all') {
            filteredFeedback = filteredFeedback.filter(item => item.type === type);
        }
        if (priority && priority !== 'all') {
            filteredFeedback = filteredFeedback.filter(item => item.priority === priority);
        }
        
        // Sort
        filteredFeedback.sort((a, b) => {
            let aVal = a[sort];
            let bVal = b[sort];
            
            if (sort === 'createdAt' || sort === 'updatedAt') {
                aVal = new Date(aVal);
                bVal = new Date(bVal);
            }
            
            if (order === 'desc') {
                return bVal > aVal ? 1 : -1;
            }
            return aVal > bVal ? 1 : -1;
        });
        
        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + parseInt(limit);
        const paginatedFeedback = filteredFeedback.slice(startIndex, endIndex);
        
        const stats = {
            total: feedback.length,
            pending: feedback.filter(f => f.status === 'pending').length,
            reviewed: feedback.filter(f => f.status === 'reviewed').length,
            resolved: feedback.filter(f => f.status === 'resolved').length
        };
        
        res.json({
            success: true,
            data: paginatedFeedback,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(filteredFeedback.length / limit),
                totalItems: filteredFeedback.length,
                itemsPerPage: parseInt(limit)
            },
            stats
        });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Get single feedback by ID
app.get('/api/feedback/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const feedbackItem = feedback.find(item => item.id === id);
        
        if (!feedbackItem) {
            return res.status(404).json({
                success: false,
                message: 'Feedback not found'
            });
        }
        
        res.json({
            success: true,
            data: feedbackItem
        });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Create new feedback
app.post('/api/feedback', validateFeedback, handleValidationErrors, (req, res) => {
    try {
        const { title, description, type, priority, email } = req.body;
        
        const newFeedback = {
            id: feedbackIdCounter++,
            title: title.trim(),
            description: description.trim(),
            type,
            priority,
            email: email.toLowerCase().trim(),
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        feedback.unshift(newFeedback);
        
        res.status(201).json({
            success: true,
            data: newFeedback,
            message: 'Feedback created successfully'
        });
    } catch (error) {
        console.error('Error creating feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Update feedback
app.put('/api/feedback/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const feedbackIndex = feedback.findIndex(item => item.id === id);
        
        if (feedbackIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Feedback not found'
            });
        }
        
        const allowedUpdates = ['status', 'priority'];
        const updates = {};
        
        Object.keys(req.body).forEach(key => {
            if (allowedUpdates.includes(key)) {
                updates[key] = req.body[key];
            }
        });
        
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid updates provided'
            });
        }
        
        feedback[feedbackIndex] = {
            ...feedback[feedbackIndex],
            ...updates,
            updatedAt: new Date().toISOString()
        };
        
        res.json({
            success: true,
            data: feedback[feedbackIndex],
            message: 'Feedback updated successfully'
        });
    } catch (error) {
        console.error('Error updating feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Delete feedback
app.delete('/api/feedback/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const feedbackIndex = feedback.findIndex(item => item.id === id);
        
        if (feedbackIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Feedback not found'
            });
        }
        
        const deletedFeedback = feedback.splice(feedbackIndex, 1)[0];
        
        res.json({
            success: true,
            data: deletedFeedback,
            message: 'Feedback deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// AI Assistant endpoint
app.post('/api/ai/ask', aiLimiter, validateAIQuery, handleValidationErrors, async (req, res) => {
    try {
        const { question } = req.body;
        
        // If OpenAI API key is available, use it; otherwise use mock response
        if (process.env.OPENAI_API_KEY) {
            try {
                const response = await axios.post(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        model: 'gpt-3.5-turbo',
                        messages: [
                            {
                                role: 'system',
                                content: `You are an AI assistant specialized in analyzing feedback data and providing insights for product management. You help teams understand feedback patterns, prioritize features, and improve user experience. Current feedback stats: ${JSON.stringify(getFeedbackStats())}`
                            },
                            {
                                role: 'user',
                                content: question
                            }
                        ],
                        max_tokens: 300,
                        temperature: 0.7
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                
                const aiResponse = response.data.choices[0].message.content;
                
                res.json({
                    success: true,
                    data: {
                        question,
                        answer: aiResponse,
                        timestamp: new Date().toISOString(),
                        source: 'openai'
                    }
                });
            } catch (apiError) {
                console.error('OpenAI API error:', apiError.response?.data || apiError.message);
                // Fall back to mock response
                const mockResponse = generateMockAIResponse(question);
                res.json({
                    success: true,
                    data: {
                        question,
                        answer: mockResponse,
                        timestamp: new Date().toISOString(),
                        source: 'mock'
                    }
                });
            }
        } else {
            // Use mock AI response
            const mockResponse = generateMockAIResponse(question);
            res.json({
                success: true,
                data: {
                    question,
                    answer: mockResponse,
                    timestamp: new Date().toISOString(),
                    source: 'mock'
                }
            });
        }
    } catch (error) {
        console.error('Error processing AI request:', error);
        res.status(500).json({
            success: false,
            message: 'AI service temporarily unavailable'
        });
    }
});

// Analytics endpoint
app.get('/api/analytics', (req, res) => {
    try {
        const stats = getFeedbackStats();
        const trends = calculateTrends();
        
        res.json({
            success: true,
            data: {
                stats,
                trends,
                generatedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error generating analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error'
        });
    }
});

// Helper functions
function getFeedbackStats() {
    const stats = {
        total: feedback.length,
        byStatus: {
            pending: feedback.filter(f => f.status === 'pending').length,
            reviewed: feedback.filter(f => f.status === 'reviewed').length,
            resolved: feedback.filter(f => f.status === 'resolved').length
        },
        byType: {
            bug: feedback.filter(f => f.type === 'bug').length,
            feature: feedback.filter(f => f.type === 'feature').length,
            improvement: feedback.filter(f => f.type === 'improvement').length,
            other: feedback.filter(f => f.type === 'other').length
        },
        byPriority: {
            low: feedback.filter(f => f.priority === 'low').length,
            medium: feedback.filter(f => f.priority === 'medium').length,
            high: feedback.filter(f => f.priority === 'high').length
        }
    };
    return stats;
}

function calculateTrends() {
    const now = new Date();
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const weeklyFeedback = feedback.filter(f => new Date(f.createdAt) >= lastWeek);
    const monthlyFeedback = feedback.filter(f => new Date(f.createdAt) >= lastMonth);
    
    return {
        weekly: {
            total: weeklyFeedback.length,
            resolved: weeklyFeedback.filter(f => f.status === 'resolved').length
        },
        monthly: {
            total: monthlyFeedback.length,
            resolved: monthlyFeedback.filter(f => f.status === 'resolved').length
        }
    };
}

function generateMockAIResponse(question) {
    const responses = [
        `Based on your current feedback data (${feedback.length} total items), I'd recommend focusing on the ${getMostCommonType()} issues first, as they represent the largest category.`,
        `Looking at your feedback patterns, you have ${feedback.filter(f => f.priority === 'high').length} high-priority items that need immediate attention. Consider addressing these to improve user satisfaction.`,
        `Your feedback shows ${feedback.filter(f => f.status === 'resolved').length} resolved items out of ${feedback.length} total. This ${Math.round((feedback.filter(f => f.status === 'resolved').length / feedback.length) * 100) || 0}% resolution rate is a good starting point for improvement.`,
        `The question "${question}" suggests you're looking for insights. Based on typical feedback patterns, I'd recommend implementing a systematic approach to categorize and prioritize issues.`,
        `From an AI perspective, your feedback data indicates opportunities for UX improvements. Consider conducting user interviews to understand the underlying needs behind the reported issues.`
    ];
    
    return responses[Math.floor(Math.random() * responses.length)];
}

function getMostCommonType() {
    const typeCounts = feedback.reduce((acc, f) => {
        acc[f.type] = (acc[f.type] || 0) + 1;
        return acc;
    }, {});
    
    return Object.keys(typeCounts).reduce((a, b) => 
        typeCounts[a] > typeCounts[b] ? a : b, 'feature'
    );
}

// Global error handler
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        message: 'Internal server error'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint not found'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 FeedbackAI API server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🤖 AI features: ${process.env.OPENAI_API_KEY ? 'OpenAI API' : 'Mock responses'}`);
});

module.exports = app;