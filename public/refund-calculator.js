/**
 * refund-calculator.js
 * Frontend calculations for refund amounts based on cancellation policies
 */

class RefundCalculator {
  /**
   * Calculate refund based on policy and days before check-in
   * @param {string} policy - 'flexible', 'moderate', or 'strict'
   * @param {number} daysBeforeCheckIn - Number of days until check-in
   * @param {number} totalPrice - Total booking price
   * @returns {Object} Refund breakdown
   */
  static calculate(policy, daysBeforeCheckIn, totalPrice) {
    const PLATFORM_FEE = 0.05; // 5%
    let refundPercentage = 0;
    
    if (policy === 'flexible') {
      refundPercentage = daysBeforeCheckIn >= 7 ? 100 : 0;
    } else if (policy === 'moderate') {
      refundPercentage = daysBeforeCheckIn >= 14 ? 50 : 0;
    } else if (policy === 'strict') {
      refundPercentage = daysBeforeCheckIn >= 30 ? 50 : 0;
    }
    
    const refundBeforeFee = (totalPrice * refundPercentage) / 100;
    const platformFeeAmount = refundBeforeFee * PLATFORM_FEE;
    const finalRefund = refundBeforeFee - platformFeeAmount;
    
    return {
      refundPercentage,
      refundAmount: Math.round(finalRefund * 100) / 100,
      platformFeeAmount: Math.round(platformFeeAmount * 100) / 100,
      hostReceives: Math.round((finalRefund * 0.95) * 100) / 100,
    };
  }

  /**
   * Get policy description
   * @param {string} policy - Cancellation policy
   * @returns {string} Human-readable description
   */
  static getDescription(policy) {
    const descriptions = {
      flexible: 'Free cancellation up to 7 days before check-in. Full refund if you cancel with 7+ days notice.',
      moderate: '50% refund if cancelled 14+ days before check-in. No refund within 14 days of check-in.',
      strict: '50% refund if cancelled 30+ days before check-in. Non-refundable if cancelled within 30 days.',
    };
    return descriptions[policy] || descriptions.moderate;
  }

  /**
   * Get policy title
   * @param {string} policy - Cancellation policy
   * @returns {string} Policy title
   */
  static getTitle(policy) {
    const titles = {
      flexible: '🔄 Flexible',
      moderate: '⚠️ Moderate',
      strict: '🔒 Strict',
    };
    return titles[policy] || policy;
  }

  /**
   * Calculate days between two dates
   * @param {Date} checkInDate - Check-in date
   * @returns {number} Days before check-in
   */
  static getDaysBeforeCheckIn(checkInDate) {
    const now = new Date();
    const checkIn = new Date(checkInDate);
    return Math.floor((checkIn - now) / (1000 * 60 * 60 * 24));
  }

  /**
   * Get refund suggestion text
   * @param {number} daysBeforeCheckIn - Days before check-in
   * @param {string} policy - Cancellation policy
   * @returns {string} Readable suggestion text
   */
  static getRefundText(daysBeforeCheckIn, policy) {
    if (daysBeforeCheckIn < 0) {
      return 'Cannot cancel after check-in';
    }

    if (policy === 'flexible') {
      if (daysBeforeCheckIn >= 7) {
        return `Full refund available (${daysBeforeCheckIn}+ days before check-in)`;
      } else {
        return `No refund (less than 7 days before check-in)`;
      }
    } else if (policy === 'moderate') {
      if (daysBeforeCheckIn >= 14) {
        return `50% refund available (${daysBeforeCheckIn}+ days before check-in)`;
      } else {
        return `No refund (less than 14 days before check-in)`;
      }
    } else if (policy === 'strict') {
      if (daysBeforeCheckIn >= 30) {
        return `50% refund available (${daysBeforeCheckIn}+ days before check-in)`;
      } else {
        return `No refund (less than 30 days before check-in)`;
      }
    }
  }
}

// Export for use in browsers
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RefundCalculator;
}
