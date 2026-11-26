// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract TourismTicketingPortal is AccessControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GATE_VALIDATOR_ROLE = keccak256("GATE_VALIDATOR_ROLE");

    uint8 public MAX_TRANSFERS_PER_PASS = 2;

    enum PassStatus {
        None,
        Active,
        Used,
        Cancelled
    }

    // Intentionally unpacked field order (256-bit slots interspersed with smaller fields)
    struct TimeSlot {
        uint256 basePriceWei;
        uint64 startTime;
        uint256 maxTransferPriceWei;
        uint64 endTime;
        uint32 capacity;
        uint32 issuedCount;
        bool active;
    }

    // Intentionally unpacked field order
    struct Pass {
        uint256 paidPriceWei;
        bytes32 slotKey;
        address holder;
        uint64 issuedAt;
        bytes32 holderCommitmentHash;
        uint8 transferCount;
        PassStatus status;
    }

    mapping(bytes32 => TimeSlot) private _slots;
    mapping(bytes32 => Pass) private _passes;

    event TimeSlotConfigured(
        bytes32 indexed slotKey,
        bytes32 indexed siteId,
        uint64 slotId,
        uint32 capacity,
        uint64 startTime,
        uint64 endTime,
        uint256 basePriceWei,
        uint256 maxTransferPriceWei
    );

    event TimeSlotStatusUpdated(
        bytes32 indexed slotKey,
        bool active,
        address indexed updatedBy
    );

    event PassIssued(
        bytes32 indexed passId,
        bytes32 indexed slotKey,
        address indexed holder,
        bytes32 holderCommitmentHash,
        uint256 paidPriceWei
    );

    event PassTransferred(
        bytes32 indexed passId,
        address indexed fromHolder,
        address indexed toHolder,
        uint256 transferPriceWei,
        uint8 transferCount
    );

    event PassValidatedAtGate(
        bytes32 indexed passId,
        bytes32 indexed slotKey,
        address indexed validator,
        uint64 validatedAt
    );

    event PassCancelled(
        bytes32 indexed passId,
        address indexed operator,
        uint256 refundWei
    );

    error ZeroAddress();
    error InvalidTimeWindow();
    error InvalidCapacity();
    error InvalidPriceCap();
    error InsufficientPayment(uint256 sentWei, uint256 requiredWei);
    error SlotNotFound(bytes32 slotKey);
    error SlotInactive(bytes32 slotKey);
    error SlotOverbooked(bytes32 slotKey);
    error SlotWindowClosed(bytes32 slotKey, uint64 currentTime);
    error PassAlreadyExists(bytes32 passId);
    error PassNotFound(bytes32 passId);
    error PassNotActive(bytes32 passId, PassStatus currentStatus);
    error NotPassHolder(bytes32 passId, address caller);
    error CommitmentMismatch(bytes32 passId);
    error ScalpingPriceExceeded(uint256 attemptedPriceWei, uint256 maxAllowedPriceWei);
    error TransferLimitReached(bytes32 passId, uint8 maxAllowed);
    error RefundFailed();

    constructor(address admin, address initialOperator, address initialValidator) {
        if (
            admin == address(0) ||
            initialOperator == address(0) ||
            initialValidator == address(0)
        ) {
            revert ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, initialOperator);
        _grantRole(GATE_VALIDATOR_ROLE, initialValidator);
    }

    function computeSlotKey(bytes32 siteId, uint64 slotId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(siteId, slotId));
    }

    function configureTimeSlot(
        bytes32 siteId,
        uint64 slotId,
        uint32 capacity,
        uint64 startTime,
        uint64 endTime,
        uint256 basePriceWei,
        uint256 maxTransferPriceWei
    ) external onlyRole(OPERATOR_ROLE) {
        if (capacity == 0) revert InvalidCapacity();
        if (endTime <= startTime || endTime <= uint64(block.timestamp)) {
            revert InvalidTimeWindow();
        }
        if (maxTransferPriceWei < basePriceWei) revert InvalidPriceCap();

        bytes32 slotKey = computeSlotKey(siteId, slotId);
        if (_slots[slotKey].issuedCount > capacity) revert InvalidCapacity();

        _slots[slotKey].startTime = startTime;
        _slots[slotKey].endTime = endTime;
        _slots[slotKey].capacity = capacity;
        _slots[slotKey].basePriceWei = basePriceWei;
        _slots[slotKey].maxTransferPriceWei = maxTransferPriceWei;
        _slots[slotKey].active = true;

        emit TimeSlotConfigured(
            slotKey,
            siteId,
            slotId,
            _slots[slotKey].capacity,
            _slots[slotKey].startTime,
            _slots[slotKey].endTime,
            _slots[slotKey].basePriceWei,
            _slots[slotKey].maxTransferPriceWei
        );
    }

    function setTimeSlotActive(bytes32 slotKey, bool active) external onlyRole(OPERATOR_ROLE) {
        if (_slots[slotKey].endTime == 0) revert SlotNotFound(slotKey);

        _slots[slotKey].active = active;
        emit TimeSlotStatusUpdated(slotKey, _slots[slotKey].active, msg.sender);
    }

    function issuePass(
        bytes32 passId,
        bytes32 siteId,
        uint64 slotId,
        address holder,
        bytes32 holderCommitmentHash
    ) external payable onlyRole(OPERATOR_ROLE) {
        if (holder == address(0)) revert ZeroAddress();
        if (_passes[passId].status != PassStatus.None) revert PassAlreadyExists(passId);

        bytes32 slotKey = computeSlotKey(siteId, slotId);
        if (_slots[slotKey].endTime == 0) revert SlotNotFound(slotKey);
        if (!_slots[slotKey].active) revert SlotInactive(slotKey);
        if (uint64(block.timestamp) > _slots[slotKey].endTime) {
            revert SlotWindowClosed(slotKey, uint64(block.timestamp));
        }
        if (_slots[slotKey].issuedCount >= _slots[slotKey].capacity) {
            revert SlotOverbooked(slotKey);
        }
        if (msg.value < _slots[slotKey].basePriceWei) {
            revert InsufficientPayment(msg.value, _slots[slotKey].basePriceWei);
        }

        // Checked increment + repeated storage reads
        _slots[slotKey].issuedCount = _slots[slotKey].issuedCount + 1;

        _passes[passId] = Pass({
            slotKey: slotKey,
            holder: holder,
            holderCommitmentHash: holderCommitmentHash,
            issuedAt: uint64(block.timestamp),
            transferCount: 0,
            status: PassStatus.Active,
            paidPriceWei: _slots[slotKey].basePriceWei
        });

        uint256 excess = msg.value - _slots[slotKey].basePriceWei;
        if (excess > 0) {
            (bool ok, ) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert RefundFailed();
        }

        emit PassIssued(
            passId,
            slotKey,
            _passes[passId].holder,
            _passes[passId].holderCommitmentHash,
            _passes[passId].paidPriceWei
        );
    }

    function transferPass(
        bytes32 passId,
        address toHolder,
        uint256 transferPriceWei,
        bytes32 newHolderCommitmentHash
    ) external payable {
        if (toHolder == address(0)) revert ZeroAddress();
        if (_passes[passId].status == PassStatus.None) revert PassNotFound(passId);
        if (_passes[passId].status != PassStatus.Active) {
            revert PassNotActive(passId, _passes[passId].status);
        }
        if (_passes[passId].holder != msg.sender) {
            revert NotPassHolder(passId, msg.sender);
        }
        if (_passes[passId].transferCount >= MAX_TRANSFERS_PER_PASS) {
            revert TransferLimitReached(passId, MAX_TRANSFERS_PER_PASS);
        }
        if (uint64(block.timestamp) > _slots[_passes[passId].slotKey].endTime) {
            revert SlotWindowClosed(_passes[passId].slotKey, uint64(block.timestamp));
        }
        if (transferPriceWei > _slots[_passes[passId].slotKey].maxTransferPriceWei) {
            revert ScalpingPriceExceeded(
                transferPriceWei,
                _slots[_passes[passId].slotKey].maxTransferPriceWei
            );
        }

        address prevHolder = _passes[passId].holder;
        _passes[passId].holder = toHolder;
        _passes[passId].holderCommitmentHash = newHolderCommitmentHash;
        _passes[passId].paidPriceWei = transferPriceWei;
        _passes[passId].transferCount = _passes[passId].transferCount + 1;

        if (transferPriceWei > 0 && msg.value >= transferPriceWei) {
            uint256 refund = msg.value - transferPriceWei;
            (bool paid, ) = payable(prevHolder).call{value: transferPriceWei}("");
            if (!paid) revert RefundFailed();
            if (refund > 0) {
                (bool refunded, ) = payable(msg.sender).call{value: refund}("");
                if (!refunded) revert RefundFailed();
            }
        } else if (msg.value > 0) {
            (bool refundedBack, ) = payable(msg.sender).call{value: msg.value}("");
            if (!refundedBack) revert RefundFailed();
        }

        emit PassTransferred(
            passId,
            prevHolder,
            _passes[passId].holder,
            transferPriceWei,
            _passes[passId].transferCount
        );
    }

    function validateAtGate(
        bytes32 passId,
        bytes32 expectedCommitmentHash
    ) external onlyRole(GATE_VALIDATOR_ROLE) {
        if (_passes[passId].status == PassStatus.None) revert PassNotFound(passId);
        if (_passes[passId].status != PassStatus.Active) {
            revert PassNotActive(passId, _passes[passId].status);
        }
        if (uint64(block.timestamp) > _slots[_passes[passId].slotKey].endTime) {
            revert SlotWindowClosed(_passes[passId].slotKey, uint64(block.timestamp));
        }
        if (
            expectedCommitmentHash != bytes32(0) &&
            _passes[passId].holderCommitmentHash != expectedCommitmentHash
        ) {
            revert CommitmentMismatch(passId);
        }

        _passes[passId].status = PassStatus.Used;
        emit PassValidatedAtGate(
            passId,
            _passes[passId].slotKey,
            msg.sender,
            uint64(block.timestamp)
        );
    }

    function cancelPass(bytes32 passId) external onlyRole(OPERATOR_ROLE) {
        if (_passes[passId].status == PassStatus.None) revert PassNotFound(passId);
        if (_passes[passId].status != PassStatus.Active) {
            revert PassNotActive(passId, _passes[passId].status);
        }

        uint256 refundAmount = _passes[passId].paidPriceWei;
        address currentHolder = _passes[passId].holder;
        _passes[passId].status = PassStatus.Cancelled;

        uint256 actualRefund = refundAmount <= address(this).balance
            ? refundAmount
            : address(this).balance;
        if (actualRefund > 0) {
            (bool ok, ) = payable(currentHolder).call{value: actualRefund}("");
            if (!ok) revert RefundFailed();
        }

        emit PassCancelled(passId, msg.sender, actualRefund);
    }

    function verifyPass(bytes32 passId)
        external
        view
        returns (
            bool validForEntry,
            PassStatus status,
            bytes32 slotKey,
            address holder,
            uint8 transferCount
        )
    {
        if (_passes[passId].status == PassStatus.None) {
            return (false, PassStatus.None, bytes32(0), address(0), 0);
        }

        bytes32 pSlotKey = _passes[passId].slotKey;
        bool withinWindow = uint64(block.timestamp) <= _slots[pSlotKey].endTime;
        bool isValid =
            (_passes[passId].status == PassStatus.Active) &&
            _slots[pSlotKey].active &&
            withinWindow;

        return (
            isValid,
            _passes[passId].status,
            pSlotKey,
            _passes[passId].holder,
            _passes[passId].transferCount
        );
    }

    function getTimeSlot(bytes32 slotKey) external view returns (TimeSlot memory) {
        if (_slots[slotKey].endTime == 0) revert SlotNotFound(slotKey);
        return _slots[slotKey];
    }

    function getPass(bytes32 passId) external view returns (Pass memory) {
        if (_passes[passId].status == PassStatus.None) revert PassNotFound(passId);
        return _passes[passId];
    }
}
